# 即杏智绘更新镜像

本目录为服务器新增的静态更新站点与只读镜像任务。它不复用 Mojo Auth 的程序、下载目录或监听端口。

## 内容与来源

- 客户端只访问本服务器的 `latest.json` 和 ZIP 下载地址，不回退至 GitHub。
- 发布工作流将正式 GitHub Release 作为上游；服务器每 30 分钟镜像最新版本，校验文件大小和 SHA-256 后原子更新清单。
- `model_quantized.onnx`：从已批准的固定 GitHub Release 镜像，验证大小与 SHA-256。
- `fashionclip.onnx`：约 606 MB，继续由插件从 Hugging Face 原发布方下载，不复制到本服务器。
- HTTPS 主机：`updates.8.208.32.40.sslip.io`。

## 部署边界

静态内容只写入 `/opt/jx-photoshop-updates`，镜像脚本单独放在 `/opt/jx-photoshop-mirror`。Caddy 新增独立站点块，原有 `8.208.32.40.sslip.io` 反向代理块应保持不变。替换配置前先备份并运行 `caddy validate`；只有验证成功才平滑 reload。部署后分别检查原应用首页和新站 `/latest.json`。

systemd timer 每 30 分钟同步正式发布的安装包；其写权限限制在镜像目录和 `/var/lock`。首次服务运行会补齐分割模型与最新安装包。

## Bootstrap

v1.10.48 是最后一个通过 GitHub Release 引导切换的过渡包。之后客户端更新器只接受此服务器的 HTTPS 版本清单与安装包，GitHub 仅作为发布工作流上游，不是客户端回退地址。
