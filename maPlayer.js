// maPlayer.js —— 2025 终极生产版（H264/H265 通用 
class maPlayer {
   constructor(videoElement, options = {}) {
        this.video = typeof videoElement === 'string' ? document.querySelector(videoElement) : videoElement;
        if (!this.video) {
            throw new Error('Video element not found');
        }

        this.config = {
            maxQueueSegments: 80,
            catchUpRate: 1.15,
            normalRate: 1.0,
            fallbackCodec: 'video/mp4; codecs="avc1.640028,mp4a.40.2"', // 最常见的 H264+AAC
            mp4boxTimeout: 12000,   // H265 init segment 较大，设置较长超时
            preferH265: true,       // H265 优先
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
            pendingInitChunk: null,     // 缓存 init segment
            lastAppendTime: 0,
            watchdogTimer: null,
            cleanupTimer: null,
            reconnectTimer: null,
            mp4boxTimer: null           // MP4Box 解析超时定时器
        };

        this.currentUrl = null;
    }

    // 获取降级 codec 字符串
    _getFallbackCodecString() {
        const candidates = this.config.preferH265 ? [
            'hev1.1.6.L93.90', 'hev1.1.6.L120.B0', 'hev1.1.6.L123.90', 'hev1.1.2.L123.80',
            'hvc1.1.6.L93.90', 'hvc1.1.6.L120.B0', 'hvc1.1.2.L123.80',
            'hev1', 'hvc1',
            'avc1.64002A', 'avc1.640028', 'avc1.64001E', 'avc1.42E01E'
        ] : [
            'avc1.640028', 'avc1.42E01E', 'avc1.64001E',
            'hev1', 'hvc1'
        ];
        for (const c of candidates) {
            if (MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`)) {
                return c;
            }
        }
        return 'avc1.64001e'; //640028
    }

    // 检查 SourceBuffer 是否有效
    _isSourceBufferValid() {
        // 确保所有必要的属性都存在
        if (!this.state.sb || !this.state.ms || !this.state.ms.sourceBuffers) {
            return false;
        }
        
        // 检查 MediaSource 状态
        if (this.state.ms.readyState !== 'open') {
            return false;
        }
        
        // sourceBuffers 是 SourceBufferList，不是数组，使用 for 循环检查
        try {
            for (let i = 0; i < this.state.ms.sourceBuffers.length; i++) {
                if (this.state.ms.sourceBuffers[i] === this.state.sb) {
                    return true;
                }
            }
        } catch (e) {
            console.warn('[maPlayer] 检查 SourceBuffer 有效性失败:', e);
            return false;
        }
        
        return false;
    }

    // 1. 队列消费（updateend 驱动）
    _drainQueue() {
        if (!this._isSourceBufferValid() || this.state.sb.updating || this.state.queue.length === 0) return;
        try {
            this.state.sb.appendBuffer(this.state.queue.shift());
            this.state.lastAppendTime = Date.now();
        } catch (e) {
            console.warn('[maPlayer] appendBuffer 失败', e);
        }
    }

    // 使用 MP4Box 解析 init segment 获取 codec
    _parseInitWithMP4Box(chunk) {
        if (typeof MP4Box === 'undefined') {
            console.warn('mp4box.js 未加载，使用降级 codec');
            this._createSourceBuffer(this._getFallbackCodecString());
            if (this.state.pendingInitChunk) {
                this.state.queue.unshift(this.state.pendingInitChunk);
                this.state.pendingInitChunk = null;
            }
            return;
        }

        const mp4boxfile = MP4Box.createFile();
        mp4boxfile.onError = e => {
            console.error('MP4Box error:', e);
            clearTimeout(this.state.mp4boxTimer);
            // MP4Box 解析失败，降级使用默认 codec
            this._createSourceBuffer(this._getFallbackCodecString());
            if (this.state.pendingInitChunk) {
                this.state.queue.unshift(this.state.pendingInitChunk);
                this.state.pendingInitChunk = null;
            }
        };

        mp4boxfile.onReady = (info) => {
            if (this.state.codecReceived) return;
            clearTimeout(this.state.mp4boxTimer);

            const videoTrack = info.videoTracks?.[0];
            const audioTrack = info.audioTracks?.[0];
            // 构建完整的 codec 字符串，包含视频和音频
            let codecParts = [];
            if (videoTrack) {
                codecParts.push(videoTrack.codec);
            }
            if (audioTrack) {
                codecParts.push(audioTrack.codec);
            }
            
            // 如果没有解析到 codec，使用降级策略
            let codec = [];
            if (codecParts.length > 0) {
                codec = codecParts.join(', ') ;
                console.log('[maPlayer] MP4Box解析codec成功:', codec);
            } else {
                codec = this._getFallbackCodecString();
                console.log('[maPlayer] MP4Box解析codec失败,_getFallbackCodecString:', codec);
            } 

            this._createSourceBuffer(codec);
        };

        try {
            // MP4Box 需要 fileStart 属性来正确解析
            const arrayBuffer = chunk;
            arrayBuffer.fileStart = 0;
            mp4boxfile.appendBuffer(arrayBuffer);
            mp4boxfile.flush();
        } catch (e) {
            console.error('MP4Box appendBuffer 失败:', e);
            clearTimeout(this.state.mp4boxTimer);
            // 异常情况下降级使用默认 codec
            this._createSourceBuffer(this._getFallbackCodecString());
            if (this.state.pendingInitChunk) {
                this.state.queue.unshift(this.state.pendingInitChunk);
                this.state.pendingInitChunk = null;
            }
        }
    }

    // 2. 创建 SourceBuffer（动态或降级）
    _createSourceBuffer(codecString) {
        if (this.state.sb || this.state.codecReceived) return;
        const mime = `video/mp4; codecs="${codecString}"`;
        console.log('[maPlayer] 尝试创建 SourceBuffer, mime => ', mime);
        
        // 验证 MIME 类型是否被支持
        if (!MediaSource.isTypeSupported(mime)) {
            console.warn(`[maPlayer] 不支持 ${mime}，尝试降级 codec`);
            // 使用不同的 codec 字符串，避免无限递归
            const fallbackCodec = this._getFallbackCodecString();
            if (fallbackCodec !== codecString) {
                this._createSourceBuffer(fallbackCodec);
            } else {
                console.error('[maPlayer] 所有 codec 都不被支持');
            }
            return;
        }
        
        try {
            this.state.sb = this.state.ms.addSourceBuffer(mime);
            this.state.sb.mode = 'segments'; // 关键！比 sequence稳
            this.state.sb.addEventListener('updateend', () => this._drainQueue());
            this.state.sb.addEventListener('error', (e) => console.error('SourceBuffer error', e));
            console.log('[maPlayer] SourceBuffer 创建成功:', codecString);
            this.state.codecReceived = true;
            
            // sb 创建成功后，立即消费 pending init chunk
            if (this.state.pendingInitChunk) {
                this.state.queue.unshift(this.state.pendingInitChunk); // 优先放队首
                this.state.pendingInitChunk = null;
                // 直接 append，不通过 _drainQueue()，避免 SourceBuffer 有效性检查问题
                try {
                    this.state.sb.appendBuffer(this.state.queue.shift());
                } catch (appendError) {
                    console.warn('[maPlayer] 直接 append init chunk 失败:', appendError);
                }
            }
        } catch (e) {
            console.error('[maPlayer] 创建 SourceBuffer 失败，尝试降级', e);
            // 使用不同的 codec 字符串，避免无限递归
            const fallbackCodec = this._getFallbackCodecString();
            if (fallbackCodec !== codecString) {
                this._createSourceBuffer(fallbackCodec);
            } else {
                console.error('[maPlayer] 所有 codec 都创建失败');
            }
        }
    }

    // 3. 启动各种守护进程
    _startGuards() {
        // 低延迟追帧 + 后台防卡死
        this.state.watchdogTimer = setInterval(() => {
            if (!this.state.playing || this.video.paused || !this.state.sb?.buffered?.length) return;

            const end = this.state.sb.buffered.end(this.state.sb.buffered.length - 1);
            const lag = end - this.video.currentTime;

            // 后台切走时强制跳最新帧
            if (document.hidden) {
                this.video.currentTime = end - 0.3;
                return;
            }

            // 前台延迟控制
            if (lag > 2.0) {
                this.video.currentTime = end - 0.3; // 跳帧
            } else if (lag > 0.9) {
                this.video.playbackRate = this.config.catchUpRate;
            } else {
                this.video.playbackRate = this.config.normalRate;
            }
        }, 500);

        // 定期清理旧缓存
        this.state.cleanupTimer = setInterval(() => {
            if (!this.state.sb || this.state.sb.updating || !this.state.sb.buffered.length) return;
            try {
                const removeBefore = this.video.currentTime - 3;
                if (removeBefore > 0) {
                    for (let i = 0; i < this.state.sb.buffered.length; i++) {
                        if (this.state.sb.buffered.end(i) < removeBefore) {
                            this.state.sb.remove(this.state.sb.buffered.start(i), this.state.sb.buffered.end(i));
                        }
                    }
                }
            } catch (e) {}
        }, 5000);
    }

    async play(wsUrl) {
        if (this.state.playing) return;
        this.currentUrl = wsUrl;
        this.state.playing = true;
        this.state.codecReceived = false;
        this.state.hasInitSegment = false;
        this.state.pendingInitChunk = null;
        this.state.queue = [];

        // MediaSource
        const ms = new MediaSource();
        this.state.ms = ms;
        this.video.src = URL.createObjectURL(ms);

        await new Promise(r => ms.addEventListener('sourceopen', r, { once: true }));

        // 超长 init 保护（H265 常见 5~10MB）
        this.state.mp4boxTimer = setTimeout(() => {
            if (!this.state.codecReceived) {
                console.warn('[maPlayer] init 解析超时，强制使用H265优先codec');
                this._createSourceBuffer(this._getFallbackCodecString());
                if (this.state.pendingInitChunk) {
                    this.state.queue.unshift(this.state.pendingInitChunk);
                    this.state.pendingInitChunk = null;
                }
            }
        }, this.config.mp4boxTimeout);

        // WebSocket
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        this.state.ws = ws;

        ws.onmessage = (e) => {
            if (!this.state.playing) return;
            const data = new Uint8Array(e.data);

            // 第一种：带 0x09 协议头的国产流
            if (!this.state.codecReceived && data[0] === 9) {
                clearTimeout(this.state.mp4boxTimer);
                const codecStr = new TextDecoder().decode(data.slice(1));
                console.log('[maPlayer] 收到 0x09 codec 包:', codecStr);
                this._createSourceBuffer(codecStr);
                this.state.codecReceived = true;
                return;
            }

            // 第二种：标准 fMP4（第一包就是 init segment）
            if (!this.state.codecReceived) {
                clearTimeout(this.state.mp4boxTimer);
                console.log('[maPlayer] 收到标准init segment, 使用MP4Box解析codec');
                
                // 缓存 init segment
                this.state.pendingInitChunk = e.data;
                // 使用 MP4Box 解析获取 codec
                this._parseInitWithMP4Box(e.data);
                return;
            }

            // 正常媒体数据
            this.state.queue.push(e.data);

            // 队列过长自动丢帧（保低延迟）
            if (this.state.queue.length > this.config.maxQueueSegments) {
                this.state.queue.splice(0, this.state.queue.length - this.config.maxQueueSegments + 20);
            }

            this._drainQueue();
        };

        ws.onclose = ws.onerror = () => {
            console.log('[maPlayer] WebSocket连接断开, 3秒后自动重连...');
            clearTimeout(this.state.mp4boxTimer);
            if (this.state.playing) {
                clearTimeout(this.state.reconnectTimer);
                this.state.reconnectTimer = setTimeout(() => this.play(wsUrl), 3000);
            }
        };

        // pause 自动恢复（防自动暂停黑屏）
        this.video.addEventListener('pause', () => {
            if (this.state.sb?.buffered?.length) {
                const end = this.state.sb.buffered.end(this.state.sb.buffered.length - 1);
                if (this.video.currentTime >= end - 0.5) {
                    this.video.currentTime = end - 0.1;
                    this.video.play().catch(() => {});
                }
            }
        });

        this._startGuards();
        this.video.play().catch(() => {});
    }

    stop() {
        this.state.playing = false;
        console.log('[maPlayer] stop 销毁释放资源...');
        
        // 清理所有定时器
        clearTimeout(this.state.reconnectTimer);
        clearTimeout(this.state.mp4boxTimer);
        [this.state.watchdogTimer, this.state.cleanupTimer].forEach(clearInterval.bind(window));

        if (this.state.ws) {
            this.state.ws.onclose = this.state.ws.onerror = null;
            this.state.ws.close();
            this.state.ws = null;
        }

        if (this.state.ms?.readyState === 'open') {
            try { this.state.ms.endOfStream(); } catch (e) {}
        }

        this.video.removeAttribute('src');
        this.video.load();

        this.state = {
            queue: [], playing: false, codecReceived: false, hasInitSegment: false,
            pendingInitChunk: null,
            lastAppendTime: 0, ws: null, ms: null, sb: null,
            mp4boxTimer: null
        };
    }
}

window.maPlayer = maPlayer;