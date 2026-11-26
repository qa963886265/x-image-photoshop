# 即杏智绘 Photoshop

即杏智绘用于 Photoshop 局部修图、内容替换和参考图生成。当前版本为 **v1.10.62**，插件源码位于 `plugin/`。

- [下载最新版](https://github.com/qa963886265/x-image-photoshop/releases/latest)
- [功能与使用说明](plugin/README.md)
- [安装和更新](plugin/安装与使用说明.md)
- [更新日志](plugin/更新日志.md)
- [第三方素材说明](plugin/THIRD_PARTY_NOTICES.md)

## 发布与更新

同步插件版本号和 `release/latest.json` 后，推送到 `main` 会触发 GitHub Actions。工作流从标签对应的 `plugin/` 目录打包并发布 ZIP。

v1.10.48 是最后一个通过 GitHub 引导安装的过渡版本。安装后，插件只访问 `https://updates.8.208.32.40.sslip.io/latest.json` 并从该服务器下载后续安装包，校验文件大小与 SHA-256，不再请求 GitHub Releases。GitHub Actions 仍可作为源码发布流程，服务器会将最新 Release 镜像到客户端更新地址。

首次安装请下载 Release 附件；已有插件可点击左上角图标或版本号检查更新。
