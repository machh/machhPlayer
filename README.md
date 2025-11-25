# machhPlayer
 
machhPlayer 是一个基于WebSocket-fMP4协议的 Web 视频播放器项目,其主要目的是实现低延迟（0-3 秒）视频播放，支持H.264和H.265编解码器，通过HTML5 <video> 标签和 Media Source Extensions (MSE) 实现原生播放。

 
## 关键特性

- 低延迟播放：延时1s左右， 通过WebSocket接收fMP4片段，直接追加到MSE的 SourceBuffer中，使用 video.buffered设置currentTime 实现从缓存片段的播放。
- 编解码支持：原生 H.264/H.265（fMP4 格式）
- 技术栈：WebSocket（流传输）、MSE（媒体追加）、HTML5 Video（渲染）
- 实现了简单的重连/退避机制及内存回收机制，
- 音频AAC


## 存在的问题
- 音视频同步播放还有问题，如果开启音频，第一次打开播放比较慢，
