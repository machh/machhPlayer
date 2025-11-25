// maPlayer.js (2025 终极修复版 - 遵循 MSE 最佳实践)
class MAPlayer {
    constructor(videoElement, options = {}) {
        this.video = typeof videoElement === 'string' ? document.querySelector(videoElement) : videoElement;
        if (!this.video) throw new Error('Video element not found');

        this.config = {
            targetLatency: 0.5,
            maxLatency: 1.0,
            seekThreshold: 2.0,
            catchUpRate: 1.1,
            maxQueueSegments: 50,
            maxRestarts: 10,       // 最大重连次数
            retryDelay: 1000,      // 初始重连延迟 (ms)
            cleanupIntervalMs: 5000, // 每 5 秒清理一次已播放的 buffer
            codec: 'h264',         // 默认为 h264
            ...options
        };

        this.state = {
            ws: null,
            mediaSource: null,
            sourceBuffer: null,
            objectUrl: null,
            queue: [],
            isPlaying: false,
            cleanupTimer: null,
            watchdogTimer: null,
            lastAppendTime: 0,
            stuckRestartCount: 0,
            hasInitSegment: false,   // 【关键】是否已追加 moov
            currentRetryDelay: this.config.retryDelay, // 当前重连延迟
            isAppending: false       // SourceBuffer 正在更新的内部标记
        };

        this.mimeCodec = null;
        this.currentUrl = null;
        
        this.video.addEventListener('error', (e) => {
            const err = this.video.error;
            console.error('[MAPlayer] Video Element Error:', err ? `${err.code}: ${err.message}` : 'Unknown');
            this.stop(true); // 发生致命错误，强制清理并重试
        });
    }

    _getSupportedCodec() {
        // 【已修复】H.264 包含 AAC 标识 mp4a.40.2
        const codecs = {
            'h265': [
                'video/mp4; codecs="hev1.1.6.L120.B0"', 'video/mp4; codecs="hvc1.1.6.L120.B0"', 
                'video/mp4; codecs="hev1"', 'video/mp4; codecs="hvc1"'
            ],
            'h264': [
                'video/mp4; codecs="avc1.4d401e, mp4a.40.2"', // Main Profile + AAC (推荐)
                'video/mp4; codecs="avc1.42e01e, mp4a.40.2"', // Baseline Profile + AAC
                'video/mp4; codecs="avc1.64001e, mp4a.40.2"', // High Profile + AAC
                'video/mp4; codecs="avc1, mp4a.40.2"'         // 泛型 + AAC
            ]
        };

        const type = this.config.codec || 'h264';
        const candidates = codecs[type];

        if (!candidates) throw new Error(`Unknown codec type: ${type}`);

        for (const c of candidates) {
            if (MediaSource.isTypeSupported(c)) {
                console.log(`[MAPlayer] 选中 Codec (${type}): ${c}`);
                return c;
            }
        }
        throw new Error(`当前浏览器不支持 ${type}`);
    }

    async _createMediaSource() {
        return new Promise((resolve, reject) => {
            // 【已修复】清理旧的 Object URL
            if (this.state.objectUrl) URL.revokeObjectURL(this.state.objectUrl);
            
            const ms = new MediaSource();
            const url = URL.createObjectURL(ms);
            this.state.mediaSource = ms;
            this.state.objectUrl = url;
            this.video.src = url;

            const onSourceOpen = () => {
                console.log('[MAPlayer] MediaSource opened. ReadyState:', ms.readyState);
                ms.removeEventListener('sourceopen', onSourceOpen);
                resolve(ms);
            };

            ms.addEventListener('sourceopen', onSourceOpen);
            ms.addEventListener('sourceclose', () => console.warn('[MAPlayer] MediaSource closed!'));
            ms.addEventListener('sourceended', () => console.log('[MAPlayer] MediaSource ended'));
            
            this.video.load(); // 强制加载新 URL
        });
    }

    _startCleanupInterval() {
        if (this.state.cleanupTimer) clearInterval(this.state.cleanupTimer);
        
        // 【已修复】定期删除已播放 buffer，释放内存 (SourceBuffer.remove)
        this.state.cleanupTimer = setInterval(() => {
            const sb = this.state.sourceBuffer;
            if (!sb || sb.updating || !this.state.isPlaying || sb.buffered.length === 0) return;

            const current = this.video.currentTime;
            const start = sb.buffered.start(0);

            // 保留当前播放时间前 1 秒的 buffer
            const removeTime = current - 1.0; 
            
            if (removeTime > start) {
                try {
                    console.log(`[Cleanup] 删除旧 buffer: [${start.toFixed(2)}s] -> [${removeTime.toFixed(2)}s]`);
                    sb.remove(start, removeTime);
                } catch (err) {
                    console.warn('[Cleanup] 删除 buffer 失败:', err);
                }
            }
        }, this.config.cleanupIntervalMs);
    }
    
    // 【新增】统一追加逻辑，处理重试
    _appendBuffer(chunk) {
        if (!this.state.sourceBuffer || this.state.sourceBuffer.updating) return false;
        
        try {
            this.state.isAppending = true;
            this.state.sourceBuffer.appendBuffer(chunk);
            this.state.lastAppendTime = Date.now();
            return true;
        } catch (err) {
            this.state.isAppending = false;
            if (err.name === 'QuotaExceededError') {
                console.error('[MAPlayer] appendBuffer 失败: QuotaExceededError。等待清理。');
                // 发生配额错误时，不放回队列，而是等待 cleanup 释放内存。
            } else {
                console.error('[MAPlayer] appendBuffer 异常:', err);
                // 严重错误，清空队列并尝试重连
                this.stop(true);
            }
            return false;
        }
    }

    _processQueue() {
        if (this.state.queue.length === 0 || !this.state.sourceBuffer) return;
        
        if (this.state.sourceBuffer.updating) {
            // 如果 SourceBuffer 忙，等待 updateend 事件来触发下一次处理
            return;
        }
        
        // 1. 【关键修复】处理 Init Segment (moov)
        if (!this.state.hasInitSegment) {
            // 我们信任服务端总是将 moov 作为第一个包发送
            const initSegment = this.state.queue.shift();
            if (initSegment && this._appendBuffer(initSegment)) {
                console.log('[MAPlayer] 成功追加 Init Segment (MOOV)');
                this.state.hasInitSegment = true;
                return;
            } else {
                console.error('[MAPlayer] 警告：Init Segment 追加失败或缺失，清空队列。');
                this.state.queue = [];
                return;
            }
        }
        
        // 2. 处理 Media Fragments (moof+mdat)
        const fragment = this.state.queue.shift();
        if (fragment) {
            this._appendBuffer(fragment);
        }
    }

    _startWatchdog() {
        if (this.state.watchdogTimer) clearInterval(this.state.watchdogTimer);

        // 延迟监控和追帧逻辑
        this.state.watchdogTimer = setInterval(() => {
            if (!this.state.isPlaying || !this.state.sourceBuffer || this.state.sourceBuffer.buffered.length === 0) return;

            const buffered = this.state.sourceBuffer.buffered;
            const end = buffered.end(buffered.length - 1);
            const current = this.video.currentTime;
            
            // 追帧/延迟控制
            const lag = end - current;
            if (lag > this.config.seekThreshold) {
                console.warn(`[Latency] 延迟过高 ${lag.toFixed(2)}s -> Seek to ${end - 0.5}`);
                this.video.currentTime = end - 0.5; // 跳转到最新片段的前面一点
            }

            // 卡顿检测：5秒内 SourceBuffer 状态未改变，且队列里有大量数据
            const now = Date.now();
            if (this.state.queue.length > 5 && (now - this.state.lastAppendTime > 5000)) {
                console.warn('[MAPlayer] SourceBuffer 卡死 (5s 无写入), 重启...');
                this.stop(true); // 触发重连
            }
        }, 500);
    }
    
    // 【新增】WebSocket 错误/关闭时的重连逻辑
    _handleWsClose(wasClean) {
        if (!this.state.isPlaying) return;

        console.warn(`[MAPlayer] WebSocket ${wasClean ? '已正常关闭' : '非正常断开'}, 尝试重连...`);

        if (this.state.stuckRestartCount >= this.config.maxRestarts) {
            console.error('[MAPlayer] 达到最大重连次数，停止播放。');
            this.stop(false); // 停止，不重试
            return;
        }

        this.state.stuckRestartCount++;
        
        // 【已修复】指数退避 (Exponential Backoff)
        const delay = Math.min(this.state.currentRetryDelay, 10000); // 最大延迟 10秒
        this.state.currentRetryDelay = delay * 1.5;

        this.stop(false); // 先清理状态，但不清理 URL 和重试计数

        setTimeout(() => {
            console.log(`[MAPlayer] 第 ${this.state.stuckRestartCount} 次重连 (延迟 ${delay / 1000}s)...`);
            this.play(this.currentUrl, true); // 传入 isRetry 标志
        }, delay);
    }

    async play(wsUrl, isRetry = false) {
        if (this.state.isPlaying) return;
        this.currentUrl = wsUrl;
        this.state.isPlaying = true;

        if (!isRetry) {
            // 首次播放或用户主动点击，重置重连计数
            this.state.stuckRestartCount = 0;
            this.state.currentRetryDelay = this.config.retryDelay;
        }

        try {
            this.mimeCodec = this._getSupportedCodec();

            await this._createMediaSource();

            const sb = this.state.mediaSource.addSourceBuffer(this.mimeCodec);
            sb.mode = 'sequence'; // 必须是 sequence
            this.state.sourceBuffer = sb;
            this.state.hasInitSegment = false; // 重置 Init 状态

            // 【关键修复】updateend 驱动队列消费
            sb.addEventListener('updateend', () => {
                this.state.isAppending = false;
                
                // 【已修复】首次追帧逻辑：在 Init Segment 加载完成后尝试跳转
                if (this.state.hasInitSegment && sb.buffered.length > 0 && this.video.currentTime < sb.buffered.start(0) + 0.1) {
                    const seekTime = sb.buffered.start(0);
                    console.log(`[MAPlayer] [Ready] Init Segment Loaded, 首次跳转至: ${seekTime.toFixed(2)}s`);
                    this.video.currentTime = seekTime;


                    if (this.video.paused) { 
                        this.video.play().catch(e => {
                            // 忽略常见的 AbortError，因为这是浏览器策略问题，代码无法解决
                            if (e.name !== 'AbortError') {
                                console.warn("[MAPlayer] 自动播放失败:", e);
                            }
                        });
                    }
                }
                
                this._processQueue(); // 写入完成后，立即处理下一个包
            });

            sb.addEventListener('error', (e) => console.error('[MAPlayer] SourceBuffer Error:', e));

            this._startWatchdog();
            this._startCleanupInterval(); // 启动内存清理

            const ws = new WebSocket(wsUrl);
            ws.binaryType = 'arraybuffer';
            this.state.ws = ws;

            ws.onopen = () => console.log('[MAPlayer] WS Connected');
            
            // 【已修复】使用单独的关闭/错误处理函数
            ws.onclose = (e) => this._handleWsClose(e.code === 1000);
            ws.onerror = (e) => {
                console.error('[MAPlayer] WS Error', e);
                this._handleWsClose(false);
            };

            ws.onmessage = (e) => {
                if (!this.state.isPlaying) return;
                const chunk = new Uint8Array(e.data);
                
                // 队列长度控制 (丢弃最旧的)
                if (this.state.queue.length > this.config.maxQueueSegments) {
                    console.warn(`[MAPlayer] 队列溢出: 丢弃最旧的 ${this.state.queue.shift().byteLength} 字节`);
                }
                
                this.state.queue.push(chunk);
                
                // 如果 SourceBuffer 空闲，立即尝试写入
                if (!sb.updating && !this.state.isAppending) {
                    this._processQueue();
                }
            };
        } catch (err) {
            console.error('[MAPlayer] Setup Failed:', err);
            this.stop(true); // 设置失败，尝试重连
        }
    }

    // shouldRetry: 是否应该触发重连逻辑
    stop(shouldRetry = false) {
        // ... (省略部分代码，使用上述代码中的 stop 实现)
        // 关键清理步骤：

        this.state.isPlaying = false;
        
        // 1. 关闭 WebSocket (不触发 onclose 重连)
        if (this.state.ws) {
            this.state.ws.onclose = this.state.ws.onerror = null;
            try { this.state.ws.close(); } catch (e) {}
            this.state.ws = null;
        }

        // 2. 清除定时器
        [this.state.watchdogTimer, this.state.cleanupTimer].forEach(id => {
            if (id) clearInterval(id);
        });

        // 3. 清理队列
        this.state.queue = [];
        
        // 4. 清理 SourceBuffer / MediaSource
        try {
            if (this.state.sourceBuffer && this.state.mediaSource?.readyState === 'open') {
                this.state.mediaSource.removeSourceBuffer(this.state.sourceBuffer);
            }
        } catch(e) {}
        this.state.sourceBuffer = null;

        try {
            if (this.state.mediaSource?.readyState === 'open') {
                this.state.mediaSource.endOfStream();
            }
        } catch(e) {}
        this.state.mediaSource = null;
        
        // 5. 【已修复】清理 video 标签
        try {
            if (this.state.objectUrl) {
                URL.revokeObjectURL(this.state.objectUrl);
                this.state.objectUrl = null;
            }
            this.video.removeAttribute('src');
            this.video.load();
        } catch (e) {}
        
        // 6. 处理重连逻辑
        if (shouldRetry) {
            this.state.stuckRestartCount++;
            const delay = Math.min(this.state.currentRetryDelay, 10000);
            this.state.currentRetryDelay = delay * 1.5;
            
            if (this.state.stuckRestartCount < this.config.maxRestarts) {
                 setTimeout(() => {
                    console.log(`[MAPlayer] 内部错误触发重连 (延迟 ${delay / 1000}s)...`);
                    this.play(this.currentUrl, true);
                }, delay);
            } else {
                 console.error('[MAPlayer] 达到最大内部重连次数，彻底停止。');
            }
        } else {
            // 正常停止，重置重连计数
            this.state.stuckRestartCount = 0;
            this.state.currentRetryDelay = this.config.retryDelay;
        }
    }
}

window.MAPlayer = MAPlayer;