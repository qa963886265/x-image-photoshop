using System;
using System.Globalization;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Threading;

internal static class JXSelectionModels
{
    private static int Main()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JXImagePhotoshop", "auto-selection");
        var log = Path.Combine(dir, "model-download-error.log");
        try
        {
            using (var mutex = new Mutex(false, @"Local\JXImagePhotoshopSelectionModels"))
            {
                try { if (!mutex.WaitOne(0)) return 0; }
                catch (AbandonedMutexException) { }
                try
                {
                    EnsureModels(dir);
                    File.Delete(log);
                    return 0;
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch (Exception error)
        {
            try { File.WriteAllText(log, error.ToString()); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return 1;
        }
    }

    private static void EnsureModels(string dir)
    {
        Directory.CreateDirectory(dir);
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        Install(dir, "model_quantized.onnx", 28837959,
            "2b18fbdd196a7ee12702c2fceaa6f812fe70d1154573a43bd62667b9157ee48d",
            "Xenova/segformer_b2_clothes/resolve/cb6ac44e641faa309f29561c1afe08d87ef52631/onnx/model_quantized.onnx");
        Install(dir, "fashionclip.onnx", 605804513,
            "dc4c724479e49d1da9598969125353113a341bd4fd5a1dbc7d528d3f1545bba9",
            "patrickjohncyh/fashion-clip/resolve/7e3ba62ce16b379a1ab479346b66f192e76f51b7/onnx/model.onnx");
    }

    private static bool Matches(string path, long size, string hash)
    {
        if (!File.Exists(path) || new FileInfo(path).Length != size) return false;
        using (var input = File.OpenRead(path))
        using (var sha = SHA256.Create())
            return String.Equals(BitConverter.ToString(sha.ComputeHash(input)).Replace("-", ""), hash, StringComparison.OrdinalIgnoreCase);
    }

    private static void Install(string dir, string name, long size, string hash, string source)
    {
        var destination = Path.Combine(dir, name);
        if (Matches(destination, size, hash)) return;
        var temporary = destination + ".download";
        try
        {
            using (var output = File.Create(temporary))
            {
                var buffer = new byte[256 * 1024];
                const long chunkSize = 16L * 1024 * 1024;
                for (long start = 0; start < size; start = output.Length)
                {
                    long end = Math.Min(start + chunkSize, size) - 1;
                    DownloadRange(source, start, end, size, name, buffer, output);
                }
            }
            if (!Matches(temporary, size, hash)) throw new InvalidDataException("Model checksum mismatch: " + name);
            if (File.Exists(destination)) File.Replace(temporary, destination, null);
            else File.Move(temporary, destination);
        }
        finally { File.Delete(temporary); }
    }

    private static void DownloadRange(string source, long start, long end, long size, string name, byte[] buffer, FileStream output)
    {
        Exception last = null;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                output.SetLength(start);
                output.Position = start;
                var request = (HttpWebRequest)WebRequest.Create("https://huggingface.co/" + source + "?download=true&part=" + Number(start));
                request.AddRange(start, end);
                request.UserAgent = "JXImagePhotoshop-SelectionModels";
                request.Timeout = 120000;
                request.ReadWriteTimeout = 120000;
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var input = response.GetResponseStream())
                {
                    if (response.ResponseUri.Scheme != "https") throw new InvalidDataException("Model download was redirected to an insecure URL");
                    if (response.StatusCode != HttpStatusCode.PartialContent ||
                        response.ContentLength != end - start + 1)
                        throw new InvalidDataException("Model host did not return a valid range: " + name);
                    int count;
                    while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        if (output.Length + count > end + 1) throw new InvalidDataException("Unexpected model size: " + name);
                        output.Write(buffer, 0, count);
                    }
                    if (output.Length != end + 1) throw new EndOfStreamException(name);
                    return;
                }
            }
            catch (Exception error) { last = error; Thread.Sleep(1200 * (attempt + 1)); }
        }
        throw new InvalidDataException("Model download failed after retries: " + name, last);
    }

    private static string Number(long value) { return value.ToString(CultureInfo.InvariantCulture); }
}
