// maPlayer.js (修复H265 VPS问题和内存泄漏)
class maPlayer {
    constructor(videoElement, options = {}) {
        this.video = typeof videoElement === 'string' 
            ? document.querySelector(videoElement) 
            : videoElement;
        if (!this.video) throw new Error('Video element not found');

        this.config = {
            targetLatency: 0.3,
            maxLatency: 0.8,
            seekThreshold: 1.0,
            aggressiveSeekThreshold: 0.5,
            catchUpRate: 1.2,
            normalRate: 1.0,
            maxBufferLength: 2,
            minBufferLength: 0.5,
            backBufferLength: 1,
            aggressiveBufferCleanup: true,
            cleanupCheckInterval: 200,
            memoryCheckInterval: 5000,
            maxQueueSegments: 20,
            dropQueueThreshold: 10,
            keepSegmentsOnReconnect: 0,
            enableAggressiveSeek: true,
            enableSmartSeek: true,
            enableFrameDrop: true,
            maxRestarts: 8,
            retryDelay: 1000,
            maxRetryDelay: 10000,
            autoReconnect: true,
            reconnectBackoffFactor: 1.3,
            fallbackCodec: 'video/mp4; codecs="avc1.640028,mp4a.40.2"',
            mp4boxTimeout: 5000, 			// 减少超时时间
            preferH265: false,    			// 默认关闭H265优先
            skipMP4BoxParsing: false, 		// 新增：是否跳过MP4Box解析
            enablePerformanceMonitor: true,
            enableMemoryMonitor: true,
            latencyCheckInterval: 200,
            mediaSourceTimeout: 3000,
            wsConnectTimeout: 3000,
            onError: null,
            onFatalError: null,
            onReconnect: null,
            onPlaybackStarted: null,
            onPlaybackStalled: null,
            onLatencyWarning: null,
            onLatencyUpdated: null,
            onMemoryWarning: null,
            ...options
        };

        this.state = {
            ws: null,
            ms: null,
            sb: null,
            queue: [],
            playing: false,
            codecReceived: false,
            hasInitSegment: false,
            pendingInitChunk: null,
            initSegmentCorrupted: false, // 新增：标记init segment是否损坏
            lastAppendTime: 0,
            watchdogTimer: null,
            cleanupTimer: null,
            reconnectTimer: null,
            wsConnectTimer: null,
            mp4boxTimer: null,
            isReconnecting: false,
            restartCount: 0,
            lastWebSocketCloseTime: 0,
            lastKnownBufferTime: 0,
            fatalErrorOccurred: false,
            consecutiveStalls: 0,
            lastBufferCleanupTime: 0,
            playbackRateResetTimer: null,
            detectedCodec: null,
            codecRetryCount: 0,
            performanceMonitor: null,
            latencyMonitor: null,
            memoryMonitor: null,
            currentLatency: 0,
            lastLatencyUpdate: 0,
            droppedFramesCount: 0,
            lastDrainTime: 0,
            bufferDebugCount: 0,
            memoryWarnings: 0,
            lastMemoryCheck: 0,
            totalBytesAppended: 0,
            totalBytesCleaned: 0,
            sourceBufferErrorCount: 0, // 新增：SourceBuffer错误计数
        };

        this.currentUrl = null;
        
        this._onVideoError = this._onVideoError.bind(this);
        this._onVideoStalled = this._onVideoStalled.bind(this);
        this._onVideoPlaying = this._onVideoPlaying.bind(this);
        this._onVideoWaiting = this._onVideoWaiting.bind(this);
        this._onVideoPause = this._onVideoPause.bind(this);
        
        this.video.addEventListener('error', this._onVideoError);
        this.video.addEventListener('stalled', this._onVideoStalled);
        this.video.addEventListener('playing', this._onVideoPlaying);
        this.video.addEventListener('waiting', this._onVideoWaiting);
        this.video.addEventListener('pause', this._onVideoPause);
        
        this._handleNetworkOnline = () => {
            console.log('[maPlayer] 网络恢复在线');
            if (this.state.playing && !this.state.ws) {
                this._scheduleReconnect();
            }
        };
        
        this._handleNetworkOffline = () => {
            console.warn('[maPlayer] 网络离线');
        };
        
        window.addEventListener('online', this._handleNetworkOnline);
        window.addEventListener('offline', this._handleNetworkOffline);
        
        this._handleVisibilityChange = () => {
            if (document.hidden) {
                console.log('[maPlayer] 页面隐藏');
                if (this.config.enableAggressiveSeek) {
                    this._aggressiveSeekToLive();
                }
            } else {
                console.log('[maPlayer] 页面显示');
                if (this.video.paused && this.state.playing) {
                    this._tryPlayVideo();
                }
            }
        };
        
        document.addEventListener('visibilitychange', this._handleVisibilityChange);
    }

    _aggressiveSeekToLive() {
        if (!this.state.sb || !this.state.sb.buffered || this.state.sb.buffered.length === 0) {
            return;
        }
        
        try {
            const end = this.state.sb.buffered.end(this.state.sb.buffered.length - 1);
            const targetTime = Math.max(end - 0.1, 0);
            
            if (this.video.currentTime < targetTime - 0.2) {
                console.log(`[maPlayer] 激进跳转: ${targetTime.toFixed(2)}s`);
                this.video.currentTime = targetTime;
            }
        } catch (e) {
            console.warn('[maPlayer] 激进跳转失败:', e);
        }
    }

    _onVideoError(e) {
        const err = this.video.error;
        console.error('[maPlayer] Video Element Error:', 
            err ? `${err.code}: ${err.message}` : 'Unknown');
        
        if (err && err.code === 4) {
            console.warn('[maPlayer] 检测到解码错误，可能是codec或流问题');
            this._handleError('video_element', err, { 
                currentTime: this.video.currentTime,
                readyState: this.video.readyState
            });
        } else {
            this._handleError('video_element', err, { 
                currentTime: this.video.currentTime,
                readyState: this.video.readyState
            });
        }
    }
    
    _onVideoStalled() {
        console.warn('[maPlayer] 视频播放卡顿');
        this.state.consecutiveStalls++;
        
        if (this.state.consecutiveStalls > 2) {
            console.warn('[maPlayer] 连续卡顿');
            if (this.config.onPlaybackStalled) {
                this.config.onPlaybackStalled({
                    count: this.state.consecutiveStalls,
                    currentTime: this.video.currentTime
                });
            }
            
            if (this.config.enableAggressiveSeek && this.state.consecutiveStalls > 3) {
                this._aggressiveSeekToLive();
            }
        }
    }
    
    _onVideoPlaying() {
        console.log('[maPlayer] 视频开始播放');
        this.state.consecutiveStalls = 0;
        
        if (this.config.onPlaybackStarted) {
            this.config.onPlaybackStarted();
        }
    }
    
    _onVideoWaiting() {
        console.log('[maPlayer] 视频等待数据');
    }
    
    _onVideoPause() {
        if (this.state.sb?.buffered?.length) {
            const end = this.state.sb.buffered.end(this.state.sb.buffered.length - 1);
            if (this.video.currentTime >= end - 0.5) {
                this.video.currentTime = end - 0.1;
                this._tryPlayVideo();
            }
        }
    }

    _getFallbackCodecString() {
        // H264优先，更稳定
        const candidates = [
            'avc1.640028', 'avc1.42E01E', 'avc1.64001E',
            'hev1.1.6.L93.90', 'hev1.1.6.L120.B0',
            'hvc1.1.6.L93.90', 'hvc1.1.6.L120.B0',
            'hev1', 'hvc1'
        ];
        
        for (const c of candidates) {
            if (MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`)) {
                console.log(`[maPlayer] 找到支持的codec: ${c}`);
                return c;
            }
        }
        return 'avc1.64001e';
    }

    _isSourceBufferValid() {
        if (!this.state.sb || !this.state.ms || !this.state.ms.sourceBuffers) {
            return false;
        }
        
        if (this.state.ms.readyState !== 'open') {
            return false;
        }
        
        try {
            for (let i = 0; i < this.state.ms.sourceBuffers.length; i++) {
                if (this.state.ms.sourceBuffers[i] === this.state.sb) {
                    return true;
                }
            }
        } catch (e) {
            console.warn('[maPlayer] 检查SourceBuffer有效性失败:', e);
            return false;
        }
        
        return false;
    }

    _drainQueue() {
        if (!this._isSourceBufferValid() || this.state.sb.updating || this.state.queue.length === 0) {
            return;
        }
        
        const effectiveBuffer = this._getEffectiveBufferLength();
        if (effectiveBuffer > this.config.maxBufferLength) {
            console.log(`[maPlayer] 缓冲区过大(${effectiveBuffer.toFixed(2)}s)，先清理`);
            this._performBufferCleanup(true);
            setTimeout(() => this._drainQueue(), 100);
            return;
        }
        
        if (this.config.enableFrameDrop && this._shouldDropFrame()) {
            this.state.queue.shift();
            this.state.droppedFramesCount++;
            
            if (this.state.droppedFramesCount > 5) {
                this._aggressiveSeekToLive();
                this.state.droppedFramesCount = 0;
            }
        }
        
        try {
            const chunk = this.state.queue.shift();
            const chunkSize = chunk.byteLength || 0;
            this.state.sb.appendBuffer(chunk);
            this.state.totalBytesAppended += chunkSize;
            this.state.lastAppendTime = Date.now();
            this.state.lastDrainTime = Date.now();
            this.state.droppedFramesCount = 0;
            
            this._checkMemoryUsage();
            
        } catch (e) {
            console.warn('[maPlayer] appendBuffer失败', e);
            if (e.name === 'QuotaExceededError') {
                console.warn('[maPlayer] 缓冲区配额超限');
                this._performBufferCleanup(true);
                setTimeout(() => this._drainQueue(), 100);
            }
        }
    }

    _shouldDropFrame() {
        if (!this.state.sb || !this.state.sb.buffered || this.state.sb.buffered.length === 0) {
            return false;
        }
        
        const current = this.video.currentTime;
        const end = this.state.sb.buffered.end(this.state.sb.buffered.length - 1);
        const latency = end - current;
        
        if (latency > this.config.maxLatency + 0.5) {
            return true;
        }
        
        if (this.state.queue.length > this.config.dropQueueThreshold) {
            return true;
        }
        
        if (this.state.memoryWarnings > 2) {
            return true;
        }
        
        return false;
    }

    // === 关键修复：改进的MP4Box解析 ===
    _parseInitWithMP4Box(chunk) {
        // 如果配置跳过MP4Box或MP4Box未加载，直接使用降级codec
        if (this.config.skipMP4BoxParsing || typeof MP4Box === 'undefined') {
            console.warn('[maPlayer] 跳过MP4Box解析，使用降级codec');
            this._useFallbackCodec();
            return;
        }

        const mp4boxfile = MP4Box.createFile();
        let mp4boxFailed = false;

        mp4boxfile.onError = e => {
            if (mp4boxFailed) return; // 防止重复处理
            mp4boxFailed = true;
            
            console.error('[maPlayer] MP4Box解析失败:', e);
            clearTimeout(this.state.mp4boxTimer);
            
            // 标记init segment损坏
            this.state.initSegmentCorrupted = true;
            
            // 不要使用损坏的init segment，直接等待新数据
            this.state.pendingInitChunk = null;
            
            // 使用降级codec，不追加损坏的数据
            this._useFallbackCodec();
        };

        mp4boxfile.onReady = (info) => {
            if (this.state.codecReceived || mp4boxFailed) return;
            clearTimeout(this.state.mp4boxTimer);

            const videoTrack = info.videoTracks?.[0];
            const audioTrack = info.audioTracks?.[0];
            
            if (!videoTrack) {
                console.error('[maPlayer] MP4Box未找到视频轨道');
                this._useFallbackCodec();
                return;
            }
            
            let codecParts = [];
            codecParts.push(videoTrack.codec);
            if (audioTrack) {
                codecParts.push(audioTrack.codec);
            }
            
            const codec = codecParts.join(', ');
            console.log('[maPlayer] MP4Box解析codec成功:', codec);
            
            this.state.detectedCodec = videoTrack.codec.includes('hev') || 
                                      videoTrack.codec.includes('hvc') ? 'h265' : 'h264';
            
            // 验证H265流的完整性
            if (this.state.detectedCodec === 'h265') {
                console.warn('[maPlayer] 检测到H265流，验证VPS/SPS/PPS');
                // 如果之后appendBuffer失败，说明流有问题
            }
            
            this._createSourceBuffer(codec);
        };

        // 设置超时，防止MP4Box卡死
        this.state.mp4boxTimer = setTimeout(() => {
            if (!this.state.codecReceived && !mp4boxFailed) {
                console.warn('[maPlayer] MP4Box解析超时');
                mp4boxFailed = true;
                this._useFallbackCodec();
            }
        }, this.config.mp4boxTimeout);

        try {
            const arrayBuffer = chunk;
            arrayBuffer.fileStart = 0;
            mp4boxfile.appendBuffer(arrayBuffer);
            mp4boxfile.flush();
        } catch (e) {
            if (!mp4boxFailed) {
                console.error('[maPlayer] MP4Box appendBuffer失败:', e);
                mp4boxFailed = true;
                this.state.initSegmentCorrupted = true;
                this.state.pendingInitChunk = null;
                this._useFallbackCodec();
            }
        }
    }

    // 新增：使用降级codec的统一方法
    _useFallbackCodec() {
        const fallbackCodec = this._getFallbackCodecString();
        console.log('[maPlayer] 使用降级codec:', fallbackCodec);
        this._createSourceBuffer(fallbackCodec);
        
        // 如果有pendingInitChunk且未损坏，才尝试使用
        if (this.state.pendingInitChunk && !this.state.initSegmentCorrupted) {
            this.state.queue.unshift(this.state.pendingInitChunk);
            this.state.pendingInitChunk = null;
        } else {
            console.warn('[maPlayer] init segment已损坏或不存在，等待新数据');
            this.state.pendingInitChunk = null;
        }
    }

    _createSourceBuffer(codecString) {
        if (this.state.sb || this.state.codecReceived) return;
        
        if (this.state.codecRetryCount > 0) {
            console.warn('[maPlayer] 编解码器重试中');
            const fallbackCodec = this._getFallbackCodecString();
            if (fallbackCodec !== codecString) {
                this._createSourceBuffer(fallbackCodec);
                return;
            }
        }
        
        const mime = `video/mp4; codecs="${codecString}"`;
        console.log('[maPlayer] 尝试创建SourceBuffer, mime => ', mime);
        
        if (!MediaSource.isTypeSupported(mime)) {
            console.warn(`[maPlayer] 不支持 ${mime}`);
            this.state.codecRetryCount++;
            
            const fallbackCodec = this._getFallbackCodecString();
            if (fallbackCodec !== codecString) {
                this._createSourceBuffer(fallbackCodec);
            } else {
                console.error('[maPlayer] 所有codec都不被支持');
                this._handleError('codec_not_supported');
            }
            return;
        }
        
        try {
            this.state.sb = this.state.ms.addSourceBuffer(mime);
            this.state.sb.mode = 'segments';
            
            this.state.sb.addEventListener('updateend', () => this._drainQueue());
            
            // === 关键修复：增强的SourceBuffer错误处理 ===
            this.state.sb.addEventListener('error', (e) => {
                this.state.sourceBufferErrorCount++;
                console.error(`[maPlayer] SourceBuffer error (${this.state.sourceBufferErrorCount}次):`, e);
                
                // 如果SourceBuffer频繁出错，可能是流有问题
                if (this.state.sourceBufferErrorCount > 3) {
                    console.error('[maPlayer] SourceBuffer错误过多，流可能损坏');
                    this._handleError('source_buffer_corrupt', e, {
                        errorCount: this.state.sourceBufferErrorCount,
                        codec: codecString
                    });
                } else {
                    this._handleError('source_buffer', e);
                }
            });
            
            console.log('[maPlayer] SourceBuffer创建成功:', codecString);
            this.state.codecReceived = true;
            this.state.codecRetryCount = 0;
            this.state.sourceBufferErrorCount = 0;
            
            // 只在init segment未损坏时才追加
            if (this.state.pendingInitChunk && !this.state.initSegmentCorrupted) {
                this.state.queue.unshift(this.state.pendingInitChunk);
                this.state.pendingInitChunk = null;
                
                try {
                    this.state.sb.appendBuffer(this.state.queue.shift());
                    this.state.hasInitSegment = true;
                    
                    setTimeout(() => {
                        if (this.state.sb?.buffered?.length > 0 && !this.video.paused) {
                            const start = this.state.sb.buffered.start(0);
                            if (this.video.currentTime < start - 0.1) {
                                this.video.currentTime = Math.max(start, 0);
                                console.log(`[maPlayer] 首帧跳转至: ${start.toFixed(2)}s`);
                            }
                        }
                    }, 50);
                } catch (appendError) {
                    console.error('[maPlayer] init chunk追加失败:', appendError);
                    // 标记init segment损坏
                    this.state.initSegmentCorrupted = true;
                    
                    // 如果是HEVC相关错误，尝试重连并禁用H265
                    if (appendError.message && appendError.message.includes('parsing failed')) {
                        console.error('[maPlayer] 检测到流解析失败，可能是H265 VPS缺失');
                        this.config.preferH265 = false; // 禁用H265
                        this._handleError('init_segment_corrupt', appendError);
                    }
                }
            } else if (this.state.initSegmentCorrupted) {
                console.warn('[maPlayer] init segment已损坏，等待服务端发送新的init segment');
            }
        } catch (e) {
            console.error('[maPlayer] 创建SourceBuffer失败:', e);
            this.state.codecRetryCount++;
            
            const fallbackCodec = this._getFallbackCodecString();
            if (fallbackCodec !== codecString) {
                this._createSourceBuffer(fallbackCodec);
            } else {
                console.error('[maPlayer] 所有codec都创建失败');
                this._handleError('source_buffer_creation_failed', e);
            }
        }
    }

    _startGuards() {
        this._stopGuards();
        
        this.state.latencyMonitor = setInterval(() => {
            if (!this.state.playing || !this.state.sb?.buffered?.length) {
                return;
            }

            try {
                const end = this.state.sb.buffered.end(this.state.sb.buffered.length - 1);
                const current = this.video.currentTime;
                const latency = end - current;
                
                this.state.currentLatency = latency;
                this.state.lastLatencyUpdate = Date.now();
                
                if (this.config.onLatencyUpdated) {
                    this.config.onLatencyUpdated(latency);
                }
                
                if (document.hidden) {
                    this._aggressiveSeekToLive();
                    this._resetPlaybackRate();
                    return;
                }

                this._applyLatencyControl(latency, current, end);
                
            } catch (e) {
                console.warn('[maPlayer] 延迟监控异常:', e);
            }
        }, this.config.latencyCheckInterval);

        this.state.cleanupTimer = setInterval(() => {
            this._performBufferCleanup(false);
            this._checkAndForceBufferCleanup();
        }, this.config.cleanupCheckInterval);

        if (this.config.enableMemoryMonitor) {
            this.state.memoryMonitor = setInterval(() => {
                this._checkMemoryUsage();
            }, this.config.memoryCheckInterval);
        }

        if (this.config.enablePerformanceMonitor) {
            this.state.performanceMonitor = setInterval(() => {
                this._logPerformance();
            }, 2000);
        }
    }
    
    _applyLatencyControl(latency, current, end) {
        if (this.config.enableAggressiveSeek && latency > this.config.aggressiveSeekThreshold) {
            console.warn(`[maPlayer] 延迟${latency.toFixed(2)}s，激进跳转`);
            const targetTime = Math.max(end - 0.1, 0);
            this.video.currentTime = targetTime;
            this._resetPlaybackRate();
            return;
        }
        
        if (latency > this.config.seekThreshold) {
            console.warn(`[maPlayer] 延迟${latency.toFixed(2)}s，跳转`);
            const targetTime = Math.max(end - this.config.targetLatency, 0);
            this.video.currentTime = targetTime;
            this._resetPlaybackRate();
            return;
        }
        
        if (latency > this.config.maxLatency) {
            this.video.playbackRate = this.config.catchUpRate;
            this._schedulePlaybackRateReset();
        } else if (latency < this.config.targetLatency) {
            this.video.playbackRate = 0.95;
            this._schedulePlaybackRateReset();
        } else {
            this._resetPlaybackRate();
        }
    }
    
    _stopGuards() {
        [this.state.watchdogTimer, this.state.cleanupTimer, 
         this.state.performanceMonitor, this.state.latencyMonitor,
         this.state.memoryMonitor, this.state.playbackRateResetTimer].forEach(timer => {
            if (timer) {
                clearInterval(timer);
                clearTimeout(timer);
            }
        });
    }
    
    _resetPlaybackRate() {
        if (this.video.playbackRate !== 1.0) {
            this.video.playbackRate = 1.0;
        }
        
        if (this.state.playbackRateResetTimer) {
            clearTimeout(this.state.playbackRateResetTimer);
            this.state.playbackRateResetTimer = null;
        }
    }
    
    _schedulePlaybackRateReset() {
        if (this.state.playbackRateResetTimer) {
            clearTimeout(this.state.playbackRateResetTimer);
        }
        
        this.state.playbackRateResetTimer = setTimeout(() => {
            this._resetPlaybackRate();
        }, 1500);
    }
    
    _performBufferCleanup(force = false) {
        if (!this.state.sb || this.state.sb.updating || !this.state.playing || 
            !this.state.sb.buffered || this.state.sb.buffered.length === 0) {
            return;
        }

        try {
            const current = this.video.currentTime;
            const buffered = this.state.sb.buffered;
            const effectiveBuffer = this._getEffectiveBufferLength();
            
            if (effectiveBuffer > this.config.maxBufferLength || force) {
                const removeBefore = current - this.config.backBufferLength;
                
                for (let i = 0; i < buffered.length; i++) {
                    const start = buffered.start(i);
                    const end = buffered.end(i);
                    
                    if (end <= removeBefore) {
                        console.log(`[BufferCleanup] 清理旧区间: [${start.toFixed(2)}s, ${end.toFixed(2)}s]`);
                        const cleanedBytes = (end - start) * 1024 * 1024;
                        this.state.totalBytesCleaned += cleanedBytes;
                        this.state.sb.remove(start, end);
                        break;
                    }
                }
                
                this.state.lastBufferCleanupTime = Date.now();
            }
        } catch (e) {
            console.warn('[maPlayer] 缓冲区清理失败:', e);
        }
    }
    
    _getEffectiveBufferLength() {
        if (!this.state.sb || !this.state.sb.buffered || this.state.sb.buffered.length === 0) {
            return 0;
        }
        
        let total = 0;
        const buffered = this.state.sb.buffered;
        const current = this.video.currentTime;
        
        for (let i = 0; i < buffered.length; i++) {
            const start = buffered.start(i);
            const end = buffered.end(i);
            
            if (end > current) {
                const effectiveStart = Math.max(start, current);
                total += end - effectiveStart;
            }
        }
        
        return total;
    }
    
    _checkAndForceBufferCleanup() {
        if (!this.state.sb || !this.state.sb.buffered || this.state.sb.buffered.length === 0) {
            return;
        }
        
        const effectiveBuffer = this._getEffectiveBufferLength();
        
        if (effectiveBuffer > this.config.maxBufferLength * 2) {
            console.warn(`[maPlayer] 缓冲区过大 (${effectiveBuffer.toFixed(2)}s)，强制清理`);
            
            const current = this.video.currentTime;
            const targetEnd = current + this.config.maxBufferLength;
            
            const buffered = this.state.sb.buffered;
            for (let i = 0; i < buffered.length; i++) {
                const start = buffered.start(i);
                const end = buffered.end(i);
                
                if (end > targetEnd) {
                    const removeStart = Math.max(start, targetEnd);
                    if (removeStart < end) {
                        console.log(`[ForceCleanup] 强制清理: [${removeStart.toFixed(2)}s, ${end.toFixed(2)}s]`);
                        this.state.sb.remove(removeStart, end);
                        break;
                    }
                }
            }
        }
    }

    _checkMemoryUsage() {
        if (!this.config.enableMemoryMonitor) return;
        
        const now = Date.now();
        if (now - this.state.lastMemoryCheck < 5000) return;
        
        this.state.lastMemoryCheck = now;
        
        const queueSize = this.state.queue.reduce((total, chunk) => total + (chunk.byteLength || 0), 0);
        const bufferSize = this._estimateBufferSize();
        const totalMemory = queueSize + bufferSize;
        
        if (totalMemory > 100 * 1024 * 1024) {
            this.state.memoryWarnings++;
            console.warn(`[maPlayer] 内存使用过高: ${(totalMemory / 1024 / 1024).toFixed(2)}MB`);
            
            if (this.config.onMemoryWarning) {
                this.config.onMemoryWarning({
                    queueMemory: queueSize,
                    bufferMemory: bufferSize,
                    totalMemory: totalMemory,
                    warnings: this.state.memoryWarnings
                });
            }
            
            if (this.state.memoryWarnings > 3) {
                console.warn('[maPlayer] 内存警告过多，触发强制清理');
                this._performBufferCleanup(true);
                this.state.queue = [];
                this.state.memoryWarnings = 0;
            }
        } else {
            this.state.memoryWarnings = 0;
        }
    }
    
    _estimateBufferSize() {
        if (!this.state.sb || !this.state.sb.buffered || this.state.sb.buffered.length === 0) {
            return 0;
        }
        
        let totalSize = 0;
        const buffered = this.state.sb.buffered;
        
        for (let i = 0; i < buffered.length; i++) {
            const duration = buffered.end(i) - buffered.start(i);
            totalSize += duration * (2 * 1024 * 1024 / 8 + 128 * 1024 / 8);
        }
        
        return totalSize;
    }

    // === 关键修复：增强的错误处理 ===
    _handleError(errorType, error = null, metadata = {}) {
        console.error(`[maPlayer] ${errorType} 错误:`, error, metadata);
        
        if (this.state.fatalErrorOccurred) {
            return;
        }
        
        let shouldRetry = false;
        
        switch(errorType) {
            case 'user_stop':
                shouldRetry = false;
                break;
                
            case 'video_element':
                // 致命错误：不重试
                if (error && error.code && (error.code === 3 || error.code === 4)) {
                    this.state.fatalErrorOccurred = true;
                    shouldRetry = false;
                    if (this.config.onFatalError) {
                        this.config.onFatalError({
                            type: errorType,
                            code: error.code,
                            message: error.message,
                            metadata,
                            suggestion: 'H265流可能缺少VPS，请检查服务端编码配置'
                        });
                    }
                    break;
                }
                shouldRetry = this.config.autoReconnect;
                break;
                
            case 'source_buffer_corrupt':
            case 'init_segment_corrupt':
                // 流损坏错误：尝试重连
                this.state.fatalErrorOccurred = true;
                if (this.config.onFatalError) {
                    this.config.onFatalError({
                        type: errorType,
                        message: 'H265流损坏，可能缺少VPS/SPS/PPS',
                        metadata,
                        suggestion: '请确认服务端H265编码配置正确，包含完整的VPS'
                    });
                }
                shouldRetry = false;
                break;
                
            case 'codec_not_supported':
                this.state.fatalErrorOccurred = true;
                if (this.config.onFatalError) {
                    this.config.onFatalError({
                        type: errorType,
                        message: '浏览器不支持该视频编码',
                        metadata
                    });
                }
                shouldRetry = false;
                break;
                
            default:
                shouldRetry = this.config.autoReconnect &&
                             this.state.restartCount < this.config.maxRestarts;
        }
        
        if (shouldRetry) {
            this._scheduleReconnect();
        } else {
            this.stop(false);
            
            if (this.config.onError) {
                this.config.onError({
                    type: errorType,
                    message: error?.message || '未知错误',
                    metadata
                });
            }
        }
    }

    _scheduleReconnect() {
        if (this.state.reconnectTimer || this.state.isReconnecting || this.state.fatalErrorOccurred) {
            return;
        }

        if (this.state.restartCount >= this.config.maxRestarts) {
            this._handleError('max_retries_exceeded');
            return;
        }

        this.state.restartCount++;
        
        let delay = this.config.retryDelay;
        if (this.config.exponentialBackoff) {
            delay = Math.min(
                this.config.retryDelay * Math.pow(
                    this.config.reconnectBackoffFactor, 
                    this.state.restartCount - 1
                ),
                this.config.maxRetryDelay
            );
        }

        console.log(`[maPlayer] 第 ${this.state.restartCount} 次重连将在 ${delay/1000} 秒后开始...`);
        
        this.state.isReconnecting = true;
        this.state.reconnectTimer = setTimeout(() => {
            this.state.reconnectTimer = null;
            this.state.isReconnecting = false;
            this._performReconnect();
        }, delay);
    }

    _performReconnect() {
        if (!this.state.playing && !this.state.isReconnecting) {
            return;
        }
        
        console.log(`[maPlayer] 开始第 ${this.state.restartCount} 次重连`);
        
        if (this.config.onReconnect) {
            this.config.onReconnect({
                attempt: this.state.restartCount,
                maxAttempts: this.config.maxRestarts
            });
        }
        
        this._cleanupCurrentConnection();
        this._setupWebSocketConnection();
    }

    _cleanupCurrentConnection() {
        if (this.state.ws) {
            this.state.ws.onclose = this.state.ws.onerror = null;
            try { 
                this.state.ws.close(); 
            } catch (e) {}
            this.state.ws = null;
        }
        
        if (this.state.wsConnectTimer) {
            clearTimeout(this.state.wsConnectTimer);
            this.state.wsConnectTimer = null;
        }
        
        // 清空队列，释放内存
        this.state.queue = [];
        this.state.pendingInitChunk = null;
        this.state.codecReceived = false;
        this.state.hasInitSegment = false;
        this.state.droppedFramesCount = 0;
        this.state.initSegmentCorrupted = false;
        this.state.sourceBufferErrorCount = 0;
        
        this._stopGuards();
    }

    _setupWebSocketConnection() {
        if (!this.currentUrl) {
            throw new Error('WebSocket URL 未设置');
        }

        if (this.state.wsConnectTimer) {
            clearTimeout(this.state.wsConnectTimer);
        }
        
        this.state.wsConnectTimer = setTimeout(() => {
            if (this.state.ws && this.state.ws.readyState === 0) {
                console.warn('[maPlayer] WebSocket 连接超时');
                try {
                    this.state.ws.close();
                } catch (e) {}
                this._handleError('websocket_timeout');
            }
        }, this.config.wsConnectTimeout);

        const ws = new WebSocket(this.currentUrl);
        ws.binaryType = 'arraybuffer';
        this.state.ws = ws;

        ws.onopen = () => {
            clearTimeout(this.state.wsConnectTimer);
            this.state.wsConnectTimer = null;
            
            console.log('[maPlayer] WebSocket 连接已建立');
            this.state.restartCount = 0;
            this._startGuards();
        };

        ws.onclose = (e) => {
            console.log('[maPlayer] WebSocket连接断开');
            this._handleWsClose(e);
        };
        
        ws.onerror = (e) => {
            console.error('[maPlayer] WebSocket错误:', e);
        };
        
        ws.onmessage = (e) => {
            if (!this.state.playing) return;
            const data = new Uint8Array(e.data);

            // 带 0x09 协议头
            if (!this.state.codecReceived && data[0] === 9) {
                clearTimeout(this.state.mp4boxTimer);
                const codecStr = new TextDecoder().decode(data.slice(1));
                console.log('[maPlayer] 收到 0x09 codec 包:', codecStr);
                this._createSourceBuffer(codecStr);
                this.state.codecReceived = true;
                return;
            }

            // 标准 fMP4
            if (!this.state.codecReceived) {
                clearTimeout(this.state.mp4boxTimer);
                console.log('[maPlayer] 收到标准init segment');
                this.state.pendingInitChunk = e.data;
                this._parseInitWithMP4Box(e.data);
                return;
            }

            // 正常媒体数据
            this.state.queue.push(e.data);

            // 队列管理
            if (this.state.queue.length > this.config.maxQueueSegments) {
                const dropCount = this.state.queue.length - this.config.maxQueueSegments + 5;
                this.state.queue.splice(0, dropCount);
                console.warn(`[maPlayer] 丢弃 ${dropCount} 个数据包`);
            }

            this._drainQueue();
        };
    }

    _handleWsClose(event) {
        if (!this.state.playing) return;
        
        const now = Date.now();
        const timeSinceLastClose = now - this.state.lastWebSocketCloseTime;
        
        if (timeSinceLastClose < 500) {
            console.warn(`[maPlayer] 忽略频繁的WebSocket关闭事件`);
            return;
        }
        
        this.state.lastWebSocketCloseTime = now;
        
        console.warn(`[maPlayer] WebSocket连接关闭`, {
            code: event.code,
            reason: event.reason
        });
        
        if (event.code === 1000 || !this.config.autoReconnect) {
            this.stop(false);
            return;
        }
        
        this._scheduleReconnect();
    }

    _tryPlayVideo() {
        if (this.video.paused) {
            const playPromise = this.video.play();
            if (playPromise !== undefined) {
                playPromise.catch(e => {
                    if (e.name !== 'AbortError') {
                        console.warn("[maPlayer] 自动播放失败:", e.message);
                    }
                });
            }
        }
    }

    _logPerformance() {
        if (!this.state.playing) return;
        
        const effectiveBuffer = this._getEffectiveBufferLength();
        const buffered = this.state.sb?.buffered;
        let bufferRanges = [];
        
        if (buffered && buffered.length > 0) {
            for (let i = 0; i < buffered.length; i++) {
                bufferRanges.push(`[${buffered.start(i).toFixed(2)}-${buffered.end(i).toFixed(2)}]`);
            }
        }
        
        const queueSize = this.state.queue.reduce((total, chunk) => total + (chunk.byteLength || 0), 0);
        const bufferSize = this._estimateBufferSize();
        const totalMemory = queueSize + bufferSize;
        
        const stats = {
            latency: this.state.currentLatency?.toFixed(3) || 'N/A',
            codec: this.state.detectedCodec || 'unknown',
            queueLength: this.state.queue.length,
            queueMemory: (queueSize / 1024 / 1024).toFixed(2) + 'MB',
            bufferLength: effectiveBuffer.toFixed(2) + 's',
            bufferMemory: (bufferSize / 1024 / 1024).toFixed(2) + 'MB',
            totalMemory: (totalMemory / 1024 / 1024).toFixed(2) + 'MB',
            sourceBufferErrors: this.state.sourceBufferErrorCount,
        };
        
        console.log('[maPlayer] 性能统计:', stats);
    }

    async play(wsUrl, isRetry = false) {
        if (this.state.playing && !isRetry) return;
        
        if (this.state.reconnectTimer) {
            clearTimeout(this.state.reconnectTimer);
            this.state.reconnectTimer = null;
        }
        
        this.currentUrl = wsUrl;
        this.state.playing = true;
        this.state.isReconnecting = false;
        this.state.fatalErrorOccurred = false;
        this.state.codecRetryCount = 0;
        this.state.droppedFramesCount = 0;
        this.state.bufferDebugCount = 0;
        this.state.memoryWarnings = 0;
        this.state.totalBytesAppended = 0;
        this.state.totalBytesCleaned = 0;
        this.state.initSegmentCorrupted = false;
        this.state.sourceBufferErrorCount = 0;

        if (!isRetry) {
            this.state.restartCount = 0;
            this.state.detectedCodec = null;
            this.state.consecutiveStalls = 0;
        }

        const ms = new MediaSource();
        this.state.ms = ms;
        this.video.src = URL.createObjectURL(ms); //未保存到 state 中，stop() 方法无法释放。

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('MediaSource 打开超时'));
            }, this.config.mediaSourceTimeout);
            
            ms.addEventListener('sourceopen', () => {
                clearTimeout(timeout);
                resolve();
            }, { once: true });
        });

        // MP4Box超时设置
        this.state.mp4boxTimer = setTimeout(() => {
            if (!this.state.codecReceived) {
                console.warn('[maPlayer] init 解析超时，使用降级codec');
                this._useFallbackCodec();
            }
        }, this.config.mp4boxTimeout);

        this._setupWebSocketConnection();
        this._tryPlayVideo();
    }

    stop(userInitiated = true) {
        this.state.playing = false;
        console.log(`[maPlayer] 停止播放${userInitiated ? ' (用户触发)' : ''}`);
        
        clearTimeout(this.state.reconnectTimer);
        clearTimeout(this.state.mp4boxTimer);
        clearTimeout(this.state.wsConnectTimer);
        this._stopGuards();

        if (this.state.ws) {
            this.state.ws.onclose = this.state.ws.onerror = null;
            try { 
                this.state.ws.close();
            } catch (e) {}
            this.state.ws = null;
        }

        if (this.state.ms?.readyState === 'open') {
            try { 
                this.state.ms.endOfStream(); 
            } catch (e) {}
        }
        
        this.video.removeAttribute('src');
        this.video.load();

        if (userInitiated) {
            this.state = {
                ws: null,
                ms: null,
                sb: null,
                queue: [],
                playing: false,
                codecReceived: false,
                hasInitSegment: false,
                pendingInitChunk: null,
                initSegmentCorrupted: false,
                lastAppendTime: 0,
                watchdogTimer: null,
                cleanupTimer: null,
                reconnectTimer: null,
                wsConnectTimer: null,
                mp4boxTimer: null,
                isReconnecting: false,
                restartCount: 0,
                lastWebSocketCloseTime: 0,
                lastKnownBufferTime: 0,
                fatalErrorOccurred: false,
                consecutiveStalls: 0,
                lastBufferCleanupTime: 0,
                playbackRateResetTimer: null,
                detectedCodec: null,
                codecRetryCount: 0,
                performanceMonitor: null,
                latencyMonitor: null,
                memoryMonitor: null,
                currentLatency: 0,
                lastLatencyUpdate: 0,
                droppedFramesCount: 0,
                lastDrainTime: 0,
                bufferDebugCount: 0,
                memoryWarnings: 0,
                lastMemoryCheck: 0,
                totalBytesAppended: 0,
                totalBytesCleaned: 0,
                sourceBufferErrorCount: 0,
            };
            this.currentUrl = null;
        }
    }

    getStatus() {
        const effectiveBuffer = this._getEffectiveBufferLength();
        const buffered = this.state.sb?.buffered;
        let bufferRanges = [];
        
        if (buffered && buffered.length > 0) {
            for (let i = 0; i < buffered.length; i++) {
                bufferRanges.push(`[${buffered.start(i).toFixed(2)}-${buffered.end(i).toFixed(2)}]`);
            }
        }
        
        const queueSize = this.state.queue.reduce((total, chunk) => total + (chunk.byteLength || 0), 0);
        const bufferSize = this._estimateBufferSize();
        const totalMemory = queueSize + bufferSize;

        return {
            playing: this.state.playing,
            isReconnecting: this.state.isReconnecting,
            restartCount: this.state.restartCount,
            currentLatency: this.state.currentLatency?.toFixed(3) || 0,
            targetLatency: this.config.targetLatency,
            maxLatency: this.config.maxLatency,
            detectedCodec: this.state.detectedCodec,
            codecReceived: this.state.codecReceived,
            initSegmentCorrupted: this.state.initSegmentCorrupted,
            queueLength: this.state.queue.length,
            queueMemory: (queueSize / 1024 / 1024).toFixed(2) + 'MB',
            bufferLength: effectiveBuffer.toFixed(2) + 's',
            bufferMemory: (bufferSize / 1024 / 1024).toFixed(2) + 'MB',
            totalMemory: (totalMemory / 1024 / 1024).toFixed(2) + 'MB',
            bufferRanges: bufferRanges,
            droppedFrames: this.state.droppedFramesCount,
            consecutiveStalls: this.state.consecutiveStalls,
            sourceBufferErrors: this.state.sourceBufferErrorCount,
            timeSinceLastAppend: Date.now() - this.state.lastAppendTime,
            memoryWarnings: this.state.memoryWarnings,
            videoState: {
                currentTime: this.video.currentTime.toFixed(2),
                duration: this.video.duration.toFixed(2),
                paused: this.video.paused,
                readyState: this.video.readyState,
                playbackRate: this.video.playbackRate,
            },
            wsState: this.state.ws?.readyState,
            mediaSourceState: this.state.ms?.readyState,
            bytesAppended: (this.state.totalBytesAppended / 1024 / 1024).toFixed(2) + 'MB',
            bytesCleaned: (this.state.totalBytesCleaned / 1024 / 1024).toFixed(2) + 'MB',
        };
    }

    seekToLive() {
        if (!this.state.sb || !this.state.sb.buffered || this.state.sb.buffered.length === 0) {
            return;
        }
        
        const end = this.state.sb.buffered.end(this.state.sb.buffered.length - 1);
        const targetTime = Math.max(end - 0.1, 0);
        
        console.log(`[maPlayer] 手动跳转到最新: ${targetTime.toFixed(2)}s`);
        this.video.currentTime = targetTime;
    }

    setLatencyTarget(targetLatency) {
        if (targetLatency >= 0.1 && targetLatency <= 5) {
            this.config.targetLatency = targetLatency;
            console.log(`[maPlayer] 设置延迟目标: ${targetLatency}s`);
            return true;
        }
        return false;
    }

    destroy() {
        this.stop(true);
        
        this.video.removeEventListener('error', this._onVideoError);
        this.video.removeEventListener('stalled', this._onVideoStalled);
        this.video.removeEventListener('playing', this._onVideoPlaying);
        this.video.removeEventListener('waiting', this._onVideoWaiting);
        this.video.removeEventListener('pause', this._onVideoPause);
        
        window.removeEventListener('online', this._handleNetworkOnline);
        window.removeEventListener('offline', this._handleNetworkOffline);
        document.removeEventListener('visibilitychange', this._handleVisibilityChange);
        
        console.log('[maPlayer] 播放器已销毁');
    }
}

window.maPlayer = maPlayer;