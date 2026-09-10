# Windows 更新程序

使用 Windows 自带的 .NET Framework 4 编译器，在插件目录下运行：

```powershell
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:winexe /optimize+ /out:.\updater\JXImageUpdater.exe /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll .\updater-src\JXImageUpdater.cs
```

发布前同步源码中的程序集版本、manifest.json 和 lib/constants.js 的版本，并重新编译。

正式发布工作流位于仓库根目录的 `.github/workflows/publish-release.yml`，由 `release/latest.json` 和对应 ZIP 安装包触发。更新程序下载 Release 标签的源码 ZIP，再定位包含相同插件 ID 的目录。

测试时不要直接启动 EXE，以免关闭正在运行的 Photoshop。
