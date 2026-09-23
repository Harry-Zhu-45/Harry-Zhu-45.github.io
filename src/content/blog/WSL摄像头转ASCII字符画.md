---
"title": "WSL摄像头转ASCII字符画"
"slug": "WSL摄像头转ASCII字符画"
"pubDate": "2026-08-28T23:00:00+08:00"
"updatedDate": "2026-08-29T17:01:00+08:00"
"categories":
  - "计算机"
"tags":
  - "AI"
---

> 环境：Windows 11 + WSL2（Ubuntu 24.04.4），摄像头经 `usbipd` 转发
> 摄像头：Sonix Technology USB2.0 HD UVC WebCam（`2b7e:b888`，`/dev/video0`）

## 一、问题现象

起因是看了这个视频：[猎奇ffmpeg像素渲染震惊到我了](https://www.bilibili.com/video/BV1H6hG6pExT/)，觉得挺好玩，就想在自己的 WSL 里在 AI agent 的辅助下也试一下用 FFmpeg + libcaca 把摄像头画面在 WSL 终端里渲染成彩色 ASCII 字符画。后来我发现没那么顺利。

不过先有个前置问题：原视频是在 Linux 系统上跑的，直接用 `/dev/video0` 就行。但我是 **WSL**，Linux 这边根本看不到摄像头——设备在 Windows 侧挂着，需要先用 PowerShell 把它转发进来（`usbipd`）：

```powershell
usbipd list                       # 记下摄像头的 busid
usbipd attach --wsl --busid <busid>   # 绑定到 WSL
```

绑定成功后，WSL 里才有 `/dev/video0` 这个设备。这一步过了，接下来才轮到 FFmpeg：

```bash
ffmpeg -f v4l2 -video_size 320x240 -i /dev/video0 -pix_fmt rgb24 -f caca -
```

结果出现两个症状：

1. 刷警告 `Dequeued v4l2 buffer contains corrupted data (153600 bytes).`（`153600 = 320×240×2`，帧长度本身是对的，只是被 V4L2 标成了损坏）
2. **Ctrl+C 很难退出**，连按多次才出现 `Received > 3 system signals, hard exiting`

## 二、排查过程

| 步骤 | 操作 | 结果 | 结论 |
| --- | --- | --- | --- |
| 1 | `lsusb`、`dmesg` | 摄像头经 usbipd 挂载成功，uvcvideo 正常识别 | 设备跟驱动都没问题 |
| 2 | `ffmpeg -f caca -list_drivers true` | 可用驱动：`ncurses`、`slang`、`x11`、`gl`、`raw`、`null` | libcaca 显示端正常，而且 WSLg 的 X11 能用 |
| 3 | YUYV 320×240@30 采集 8 秒（`-input_format yuyv422 -f null -`） | **零帧输出，进程卡死**，SIGTERM 无效，只能 SIGKILL | YUYV 裸流在 usbipd 下基本跑不动 |
| 4 | MJPEG 320×240@30 采集 10 秒 | **0 个 corrupted**，帧号跑到 280+ | MJPEG 妥妥的 |
| 5 | MJPEG 640×480@30 采集 10 秒 | 0 个 corrupted | 高分辨率 MJPEG 也稳 |
| 6 | MJPEG → `-pix_fmt rgb24` → `-f caca -driver null` 完整链路 8 秒 | 无任何错误输出 | 端到端链路验证通过 |

日志里还有几条无害噪音，可以无视：

- `Application provided invalid, non monotonically increasing dts to muxer`—— usbipd 时间戳抖动导致的，不影响采集
- `deprecated pixel format used` —— MJPEG 解码后 YUVJ 色彩范围的例行提示

## 三、根因分析

- 未压缩的 **YUYV 裸流走 USB 等时传输（isochronous transfer）**，约 36.9 Mbit/s；而 **usbipd 转发等时传输不太行**，数据包被内核标成 corrupted，读取还可能阻塞，把 ffmpeg 卡死。
- **MJPEG 是压缩流**（320×240 只有约 3–5 Mbit/s），对 usbipd 转发不敏感，实测完全稳定。

所以修复思路就一条：**强制摄像头输出 MJPEG，别让 FFmpeg 自动协商回 YUYV**。

## 四、最终可用命令

### 终端内显示（ncurses，推荐）

```bash
ffmpeg -loglevel error -f v4l2 -input_format mjpeg -video_size 640x480 -framerate 30 -i /dev/video0 -pix_fmt rgb24 -f caca -
```

### 独立图形窗口显示（WSLg X11）

```bash
ffmpeg -loglevel error -f v4l2 -input_format mjpeg -video_size 640x480 -framerate 30 -i /dev/video0 -pix_fmt rgb24 -f caca -driver x11 -window_size 640x480 -
```

## 五、使用注意

- **关键参数是 `-input_format mjpeg`** —— 省略它 FFmpeg 会自动协商回 YUYV，问题复现。
- `-loglevel error` 用来屏蔽上面那几条无害的 dts / 色彩范围警告。
- `-pix_fmt rgb24` **不是**让摄像头输出 RGB24（摄像头硬件只提供 YUYV 和 MJPEG），它只指定交给 libcaca 之前的转换格式（libcaca 只吃 RGB24）；摄像头侧格式由 `-input_format` 决定。
- 退出直接按 **`q`**，MJPEG 模式下能正常退出，不用连按 Ctrl+C。
- 终端 ncurses 模式下字符画尺寸跟随终端大小——**终端窗口拉得越大，字符画越精细**。
- 要是哪天又冒出 `corrupted data`：先确认命令里带的是 `mjpeg`；再查 usbipd 是否掉线（Windows 侧 `usbipd attach --wsl` 重新绑定）。

## 六、速查：验证命令

```bash
# 摄像头采集稳定性（10 秒，只看警告）
timeout -s KILL 10 ffmpeg -hide_banner -nostats -loglevel warning \
  -f v4l2 -input_format mjpeg -video_size 640x480 -framerate 30 \
  -i /dev/video0 -f null -

# libcaca 可用驱动
ffmpeg -hide_banner -f lavfi -i testsrc=size=320x240:rate=10 \
  -pix_fmt rgb24 -f caca -list_drivers true -
```
