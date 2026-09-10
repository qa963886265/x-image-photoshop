using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("即杏智绘更新程序")]
[assembly: AssemblyDescription("即杏智绘 Photoshop 插件更新程序")]
[assembly: AssemblyCompany("即杏智绘项目团队")]
[assembly: AssemblyProduct("即杏智绘")]
[assembly: AssemblyVersion("1.10.2.0")]
[assembly: AssemblyFileVersion("1.10.2.0")]

namespace JXImageUpdater
{
    internal static class Program
    {
        private const string PluginId = "llai.psapi.selectioneditor";
        private const string LatestReleaseApi = "https://api.github.com/repos/qa963886265/x-image-photoshop/releases/latest";
        private const string ReleaseArchiveTemplate = "https://github.com/qa963886265/x-image-photoshop/archive/refs/tags/{0}.zip";
        private const long MaxPackageBytes = 300L * 1024L * 1024L;
        private static readonly string LogPath = Path.Combine(Path.GetTempPath(), "JXImageUpdater.log");
        private static Mutex instanceMutex;
        private static bool ownsInstanceMutex;

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                bool applying = args.Length >= 2 && String.Equals(args[0], "--apply", StringComparison.OrdinalIgnoreCase);
                if (!TryAcquireInstanceMutex(applying)) return;
                if (applying)
                {
                    ApplyUpdate(Path.GetFullPath(args[1]));
                    return;
                }
                LaunchElevatedCopy();
            }
            catch (Exception error)
            {
                Log(error.ToString());
                MessageBox.Show(
                    "更新没有完成：\r\n\r\n" + FriendlyMessage(error) + "\r\n\r\n日志：" + LogPath,
                    "即杏智绘更新",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
            finally
            {
                ReleaseInstanceMutex();
            }
        }

        private static bool TryAcquireInstanceMutex(bool applying)
        {
            // The launcher can still be alive when its elevated child starts. Keep
            // separate locks so only competing launchers or apply processes contend.
            string mutexName = applying ? "Local\\JXImagePhotoshopUpdater" : "Local\\JXImagePhotoshopUpdaterLauncher";
            instanceMutex = new Mutex(false, mutexName);
            try
            {
                ownsInstanceMutex = instanceMutex.WaitOne(0);
            }
            catch (AbandonedMutexException)
            {
                // A previous updater stopped unexpectedly; WaitOne granted ownership.
                ownsInstanceMutex = true;
            }
            return ownsInstanceMutex;
        }

        private static void ReleaseInstanceMutex()
        {
            if (instanceMutex == null) return;
            try
            {
                if (ownsInstanceMutex) instanceMutex.ReleaseMutex();
            }
            finally
            {
                ownsInstanceMutex = false;
                instanceMutex.Dispose();
                instanceMutex = null;
            }
        }

        private static void LaunchElevatedCopy()
        {
            string installDirectory = FindInstalledPluginDirectory();
            string tempDirectory = Path.Combine(Path.GetTempPath(), "JXImageUpdater-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDirectory);
            string tempExecutable = Path.Combine(tempDirectory, "JXImageUpdater.exe");
            File.Copy(Assembly.GetExecutingAssembly().Location, tempExecutable, true);

            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = tempExecutable;
            start.Arguments = "--apply \"" + installDirectory.Replace("\"", "\\\"") + "\"";
            start.UseShellExecute = true;
            start.Verb = "runas";
            Process launched = Process.Start(start);
            if (launched == null) throw new InvalidOperationException("无法启动更新程序");
        }

        private static void ApplyUpdate(string installDirectory)
        {
            ValidateInstalledPlugin(installDirectory);
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            string currentVersion = ReadPluginVersion(Path.Combine(installDirectory, "manifest.json"));
            ReleaseInfo release = ReadLatestRelease();
            if (CompareVersions(release.Version, currentVersion) <= 0)
            {
                MessageBox.Show(
                    "当前已经是最新版 v" + currentVersion + "。",
                    "即杏智绘更新",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                return;
            }

            string workDirectory = Path.Combine(Path.GetTempPath(), "JXImageUpdateWork-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(workDirectory);
            string packagePath = Path.Combine(workDirectory, release.AssetName);
            string extractedDirectory = Path.Combine(workDirectory, "extracted");
            string photoshopPath = FindPhotoshopExecutable();
            try
            {
                DownloadPackage(release, packagePath);
                Directory.CreateDirectory(extractedDirectory);
                ExtractZipSafely(packagePath, extractedDirectory);
                string newPluginDirectory = FindPluginDirectory(extractedDirectory);
                string packageVersion = ReadPluginVersion(Path.Combine(newPluginDirectory, "manifest.json"));
                if (!String.Equals(NormalizeVersion(packageVersion), NormalizeVersion(release.Version), StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("Release 版本号和安装包 manifest.json 不一致");
                }

                ClosePhotoshopAndWait();
                ReplacePluginDirectory(installDirectory, newPluginDirectory);
                Log("Updated plugin to v" + release.Version);
                if (!String.IsNullOrWhiteSpace(photoshopPath) && File.Exists(photoshopPath))
                {
                    Process.Start(new ProcessStartInfo(photoshopPath) { UseShellExecute = true });
                }
            }
            finally
            {
                TryDeleteDirectory(workDirectory);
            }
        }

        private static ReleaseInfo ReadLatestRelease()
        {
            using (TimeoutWebClient client = CreateWebClient())
            {
                string json = client.DownloadString(LatestReleaseApi);
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = 1024 * 1024;
                Dictionary<string, object> root = serializer.Deserialize<Dictionary<string, object>>(json);
                if (root == null) throw new InvalidDataException("GitHub 没有返回可用的 Release 信息");
                string tag = GetString(root, "tag_name");
                string version = NormalizeVersion(tag);
                if (String.IsNullOrWhiteSpace(version)) throw new InvalidDataException("最新 Release 没有正确的版本标签");

                string safeTag = tag.Trim();
                string url = String.Format(ReleaseArchiveTemplate, Uri.EscapeDataString(safeTag));
                string assetName = "x-image-photoshop-" + safeTag + ".zip";
                if (!Uri.IsWellFormedUriString(url, UriKind.Absolute) || !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("更新包下载地址无效");
                }
                return new ReleaseInfo(version, assetName, url, 0L);
            }
        }

        private static void DownloadPackage(ReleaseInfo release, string destination)
        {
            using (TimeoutWebClient client = CreateWebClient())
            {
                client.DownloadFile(release.DownloadUrl, destination);
            }
            FileInfo file = new FileInfo(destination);
            if (!file.Exists || file.Length <= 0 || file.Length > MaxPackageBytes)
            {
                throw new InvalidDataException("下载的更新包为空或过大");
            }
            if (release.AssetSize > 0 && file.Length != release.AssetSize)
            {
                throw new InvalidDataException("更新包下载不完整，请稍后重试");
            }
            Log("Downloaded " + release.AssetName + " SHA256=" + ComputeSha256(destination));
        }

        private static TimeoutWebClient CreateWebClient()
        {
            TimeoutWebClient client = new TimeoutWebClient();
            client.Headers[HttpRequestHeader.UserAgent] = "JX-Image-Photoshop-Updater";
            client.Headers[HttpRequestHeader.Accept] = "application/vnd.github+json";
            return client;
        }

        private static void ExtractZipSafely(string zipPath, string destination)
        {
            string root = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            using (ZipArchive archive = ZipFile.OpenRead(zipPath))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string normalizedName = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    string target = Path.GetFullPath(Path.Combine(destination, normalizedName));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidDataException("更新包包含不安全的文件路径");
                    }
                    if (String.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream input = entry.Open())
                    using (FileStream output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        input.CopyTo(output);
                    }
                }
            }
        }

        private static string FindPluginDirectory(string extractedDirectory)
        {
            foreach (string manifestPath in Directory.GetFiles(extractedDirectory, "manifest.json", SearchOption.AllDirectories))
            {
                try
                {
                    if (String.Equals(ReadManifestId(manifestPath), PluginId, StringComparison.Ordinal))
                    {
                        return Path.GetDirectoryName(manifestPath);
                    }
                }
                catch
                {
                    // Continue checking other manifest files in the archive.
                }
            }
            throw new InvalidDataException("更新包中没有找到即杏智绘插件");
        }

        private static void ClosePhotoshopAndWait()
        {
            if (!IsPhotoshopRunning()) return;
            Process[] processes = Process.GetProcessesByName("Photoshop");
            foreach (Process process in processes)
            {
                try { process.CloseMainWindow(); }
                finally { process.Dispose(); }
            }

            Stopwatch timer = Stopwatch.StartNew();
            while (IsPhotoshopRunning() && timer.Elapsed < TimeSpan.FromSeconds(90))
            {
                Thread.Sleep(250);
            }
            if (IsPhotoshopRunning())
            {
                throw new InvalidOperationException("Photoshop 未能自动关闭，更新尚未替换任何文件。请关闭 Photoshop 后重新点击更新");
            }
        }

        private static void ReplacePluginDirectory(string installDirectory, string newPluginDirectory)
        {
            string parent = Directory.GetParent(installDirectory).FullName;
            string folderName = new DirectoryInfo(installDirectory).Name;
            string suffix = Guid.NewGuid().ToString("N").Substring(0, 10);
            string prepared = Path.Combine(parent, "." + folderName + ".new-" + suffix);
            string backup = Path.Combine(parent, "." + folderName + ".backup-" + suffix);
            CopyDirectory(newPluginDirectory, prepared);
            ValidateInstalledPlugin(prepared);

            bool oldMoved = false;
            try
            {
                Directory.Move(installDirectory, backup);
                oldMoved = true;
                Directory.Move(prepared, installDirectory);
                TryDeleteDirectory(backup);
            }
            catch
            {
                if (!Directory.Exists(installDirectory) && oldMoved && Directory.Exists(backup))
                {
                    Directory.Move(backup, installDirectory);
                }
                throw;
            }
            finally
            {
                TryDeleteDirectory(prepared);
            }
        }

        private static void CopyDirectory(string source, string destination)
        {
            Directory.CreateDirectory(destination);
            foreach (string directory in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
            {
                string relative = directory.Substring(source.Length).TrimStart(Path.DirectorySeparatorChar);
                Directory.CreateDirectory(Path.Combine(destination, relative));
            }
            foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
            {
                string relative = file.Substring(source.Length).TrimStart(Path.DirectorySeparatorChar);
                string target = Path.Combine(destination, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(file, target, true);
            }
        }

        private static void ValidateInstalledPlugin(string directory)
        {
            string manifestPath = Path.Combine(directory, "manifest.json");
            if (!Directory.Exists(directory) || !File.Exists(manifestPath) || !String.Equals(ReadManifestId(manifestPath), PluginId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("更新程序没有在正确的即杏智绘插件目录中运行");
            }
        }

        private static string FindInstalledPluginDirectory()
        {
            string current = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
            for (int depth = 0; depth < 4 && !String.IsNullOrWhiteSpace(current); depth++)
            {
                string manifestPath = Path.Combine(current, "manifest.json");
                if (File.Exists(manifestPath))
                {
                    try
                    {
                        if (String.Equals(ReadManifestId(manifestPath), PluginId, StringComparison.Ordinal))
                        {
                            return current;
                        }
                    }
                    catch
                    {
                        // Continue upward. Only a matching plugin manifest is accepted.
                    }
                }

                DirectoryInfo parent = Directory.GetParent(current);
                if (parent == null) break;
                current = parent.FullName;
            }
            throw new InvalidOperationException("没有找到即杏智绘插件目录，请确认更新程序仍放在插件的 updater 文件夹中");
        }

        private static string ReadManifestId(string manifestPath)
        {
            Dictionary<string, object> manifest = ReadJsonFile(manifestPath);
            return GetString(manifest, "id");
        }

        private static string ReadPluginVersion(string manifestPath)
        {
            Dictionary<string, object> manifest = ReadJsonFile(manifestPath);
            string version = NormalizeVersion(GetString(manifest, "version"));
            if (String.IsNullOrWhiteSpace(version)) throw new InvalidDataException("manifest.json 没有正确的版本号");
            return version;
        }

        private static Dictionary<string, object> ReadJsonFile(string path)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            return serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
        }

        private static string FindPhotoshopExecutable()
        {
            foreach (Process process in Process.GetProcessesByName("Photoshop"))
            {
                try
                {
                    string path = process.MainModule.FileName;
                    if (File.Exists(path)) return path;
                }
                catch
                {
                    // Reopening Photoshop is optional.
                }
                finally
                {
                    process.Dispose();
                }
            }
            return String.Empty;
        }

        private static bool IsPhotoshopRunning()
        {
            Process[] processes = Process.GetProcessesByName("Photoshop");
            bool running = processes.Length > 0;
            foreach (Process process in processes) process.Dispose();
            return running;
        }

        private static int CompareVersions(string left, string right)
        {
            Version leftVersion;
            Version rightVersion;
            if (!Version.TryParse(NormalizeVersion(left), out leftVersion) || !Version.TryParse(NormalizeVersion(right), out rightVersion))
            {
                throw new InvalidDataException("版本号格式不正确，应为 1.7.34 这种格式");
            }
            return leftVersion.CompareTo(rightVersion);
        }

        private static string NormalizeVersion(string value)
        {
            string text = String.IsNullOrWhiteSpace(value) ? String.Empty : value.Trim();
            if (text.StartsWith("v", StringComparison.OrdinalIgnoreCase)) text = text.Substring(1);
            int separator = text.IndexOfAny(new[] { '-', '+' });
            if (separator >= 0) text = text.Substring(0, separator);
            return text.Trim();
        }

        private static string GetString(Dictionary<string, object> value, string key)
        {
            object item;
            return value != null && value.TryGetValue(key, out item) && item != null ? Convert.ToString(item) : String.Empty;
        }

        private static long GetLong(Dictionary<string, object> value, string key)
        {
            object item;
            long result;
            return value != null && value.TryGetValue(key, out item) && item != null && Int64.TryParse(Convert.ToString(item), out result) ? result : 0L;
        }

        private static string ComputeSha256(string path)
        {
            using (SHA256 hash = SHA256.Create())
            using (FileStream stream = File.OpenRead(path))
            {
                byte[] digest = hash.ComputeHash(stream);
                StringBuilder text = new StringBuilder(digest.Length * 2);
                foreach (byte value in digest) text.Append(value.ToString("x2"));
                return text.ToString();
            }
        }

        private static string FriendlyMessage(Exception error)
        {
            if (error is WebException) return "无法连接 GitHub，请检查网络后重试。";
            if (error is UnauthorizedAccessException) return "没有权限替换 Photoshop 插件目录，请允许管理员权限后重试。";
            if (error is OperationCanceledException) return "本次更新已取消，旧版本没有修改。";
            return error.Message;
        }

        private static void TryDeleteDirectory(string path)
        {
            if (String.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return;
            try { Directory.Delete(path, true); }
            catch { Log("Unable to remove temporary directory: " + path); }
        }

        private static void Log(string message)
        {
            try
            {
                File.AppendAllText(LogPath, DateTime.Now.ToString("s") + " " + message + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        private sealed class ReleaseInfo
        {
            internal readonly string Version;
            internal readonly string AssetName;
            internal readonly string DownloadUrl;
            internal readonly long AssetSize;

            internal ReleaseInfo(string version, string assetName, string downloadUrl, long assetSize)
            {
                Version = version;
                AssetName = assetName;
                DownloadUrl = downloadUrl;
                AssetSize = assetSize;
            }
        }

        private sealed class TimeoutWebClient : WebClient
        {
            protected override WebRequest GetWebRequest(Uri address)
            {
                WebRequest request = base.GetWebRequest(address);
                request.Timeout = 30000;
                HttpWebRequest http = request as HttpWebRequest;
                if (http != null)
                {
                    http.ReadWriteTimeout = 30000;
                    http.AllowAutoRedirect = true;
                    http.MaximumAutomaticRedirections = 8;
                }
                return request;
            }
        }
    }
}
