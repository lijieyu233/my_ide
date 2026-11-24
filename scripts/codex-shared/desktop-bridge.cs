using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;

class CodexBridge
{
    static string Quote(string value)
    {
        return "\"" + Regex.Replace(value, "(\\\\*)\"|(\\\\+)$", match =>
            match.Groups[1].Success ? match.Groups[1].Value + match.Groups[1].Value + "\\\"" : match.Value + match.Value) + "\"";
    }

    static void Pump(Stream input, Stream output)
    {
        byte[] bytes = new byte[16384];
        int count;
        while ((count = input.Read(bytes, 0, bytes.Length)) > 0)
        {
            output.Write(bytes, 0, count);
            output.Flush();
        }
    }

    static int Main(string[] args)
    {
        int command = Array.IndexOf(args, "app-server");
        bool isStdioServer = command >= 0 && (command == args.Length - 1 || args[command + 1].StartsWith("-"))
            && !args.Contains("--print-startup-config");
        string executable = Environment.GetEnvironmentVariable(isStdioServer ? "MYIDE_CODEX_BRIDGE_NODE" : "MYIDE_CODEX_BRIDGE_NATIVE");
        if (String.IsNullOrEmpty(executable))
        {
            Console.Error.WriteLine("Start Codex with the MyIDE shared launcher.");
            return 1;
        }

        string arguments = isStdioServer ? Quote(Environment.GetEnvironmentVariable("MYIDE_CODEX_BRIDGE_SCRIPT"))
            : String.Join(" ", Array.ConvertAll(args, Quote));
        var start = new ProcessStartInfo(executable, arguments)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.EnvironmentVariables["CODEX_HOME"] = Environment.GetEnvironmentVariable("MYIDE_CODEX_BRIDGE_HOME");

        using (Process child = Process.Start(start))
        {
            var input = new Thread(() => {
                try { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
                catch (IOException) { }
                finally { try { child.StandardInput.Close(); } catch (IOException) { } }
            });
            var output = new Thread(() => {
                try { Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()); } catch (IOException) { }
            });
            var errors = new Thread(() => {
                try { Pump(child.StandardError.BaseStream, Console.OpenStandardError()); } catch (IOException) { }
            });
            input.IsBackground = output.IsBackground = errors.IsBackground = true;
            input.Start();
            output.Start();
            errors.Start();
            child.WaitForExit();
            output.Join();
            errors.Join();
            return child.ExitCode;
        }
    }
}
