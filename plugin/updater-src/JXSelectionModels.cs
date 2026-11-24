using System;
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
            "https://github.com/qa963886265/x-image-photoshop/releases/download/selection-models-v1/model_quantized.onnx",
            "https://huggingface.co/Xenova/segformer_b2_clothes/resolve/cb6ac44e641faa309f29561c1afe08d87ef52631/onnx/model_quantized.onnx");
        Install(dir, "fashionclip.onnx", 605804513,
            "dc4c724479e49d1da9598969125353113a341bd4fd5a1dbc7d528d3f1545bba9",
            "https://huggingface.co/patrickjohncyh/fashion-clip/resolve/7e3ba62ce16b379a1ab479346b66f192e76f51b7/onnx/model.onnx");
    }

    private static bool Matches(string path, long size, string hash)
    {
        if (!File.Exists(path) || new FileInfo(path).Length != size) return false;
        using (var input = File.OpenRead(path))
        using (var sha = SHA256.Create())
            return String.Equals(BitConverter.ToString(sha.ComputeHash(input)).Replace("-", ""), hash, StringComparison.OrdinalIgnoreCase);
    }

    private static void Install(string dir, string name, long size, string hash, params string[] sources)
    {
        var destination = Path.Combine(dir, name);
        if (Matches(destination, size, hash)) return;
        var temporary = destination + ".download";
        Exception lastError = null;
        try
        {
            foreach (var source in sources)
            {
                try
                {
                    var request = (HttpWebRequest)WebRequest.Create(source);
                    request.UserAgent = "JXImagePhotoshop-SelectionModels";
                    request.Timeout = 300000;
                    request.ReadWriteTimeout = 120000;
                    using (var response = (HttpWebResponse)request.GetResponse())
                    using (var input = response.GetResponseStream())
                    using (var output = File.Create(temporary))
                    {
                        if (response.ResponseUri.Scheme != "https") throw new InvalidDataException("Expected HTTPS");
                        var buffer = new byte[256 * 1024];
                        int count;
                        while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            if (output.Length + count > size) throw new InvalidDataException("Unexpected model size: " + name);
                            output.Write(buffer, 0, count);
                        }
                    }
                    if (!Matches(temporary, size, hash)) throw new InvalidDataException("Model checksum mismatch: " + name);
                    if (File.Exists(destination)) File.Replace(temporary, destination, null);
                    else File.Move(temporary, destination);
                    return;
                }
                catch (Exception error) { lastError = error; }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
            }
            throw new InvalidOperationException("Unable to download a verified model: " + name, lastError);
        }
        finally { File.Delete(temporary); }
    }
}
