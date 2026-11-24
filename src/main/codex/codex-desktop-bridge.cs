using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

class CodexBridge
{
    static int Main(string[] args)
    {
        try
        {
            int command = Array.IndexOf(args, "app-server");
            bool isStdioServer = command >= 0 && (command == args.Length - 1 || args[command + 1].StartsWith("-"))
                && !args.Contains("--print-startup-config");
            return isStdioServer ? new Relay().Run().GetAwaiter().GetResult() : RunNative(args);
        }
        catch
        {
            Console.Error.WriteLine("Codex shared connection is unavailable.");
            return 1;
        }
    }

    static string Quote(string value)
    {
        return "\"" + Regex.Replace(value, "(\\\\*)\"|(\\\\+)$", match =>
            match.Groups[1].Success ? match.Groups[1].Value + match.Groups[1].Value + "\\\"" : match.Value + match.Value) + "\"";
    }

    static void Pump(Stream input, Stream output)
    {
        try
        {
            byte[] bytes = new byte[16384];
            int count;
            while ((count = input.Read(bytes, 0, bytes.Length)) > 0)
            {
                output.Write(bytes, 0, count);
                output.Flush();
            }
        }
        catch (IOException) { }
    }

    static int RunNative(string[] args)
    {
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("MYIDE_CODEX_BRIDGE_NATIVE"),
            String.Join(" ", Array.ConvertAll(args, Quote)))
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
                Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream);
                try { child.StandardInput.Close(); } catch (IOException) { }
            });
            var output = new Thread(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
            var errors = new Thread(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError()));
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

    class Relay
    {
        static readonly Encoding Utf8 = new UTF8Encoding(false, true);
        readonly bool desktop = Environment.GetEnvironmentVariable("MYIDE_CODEX_BRIDGE_CLIENT") == "desktop";
        readonly ClientWebSocket socket = new ClientWebSocket();
        readonly SemaphoreSlim sendLock = new SemaphoreSlim(1);
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
        readonly Dictionary<string, string> activeTurns = new Dictionary<string, string>();
        readonly Dictionary<string, HistoryRead> reads = new Dictionary<string, HistoryRead>();
        readonly Dictionary<string, EffortUpdate> efforts = new Dictionary<string, EffortUpdate>();
        readonly HashSet<string> relayed = new HashSet<string>();
        long revision;

        struct HistoryRead
        {
            public string ThreadId;
            public long Revision;
        }

        class EffortUpdate
        {
            public string threadId { get; set; }
            public string turnId { get; set; }
            public string effort { get; set; }
        }

        public async Task<int> Run()
        {
            var url = new Uri(Environment.GetEnvironmentVariable("MYIDE_CODEX_BRIDGE_URL"));
            if (url.Scheme != "ws" || url.Host != "127.0.0.1" || url.UserInfo.Length != 0)
                throw new IOException("Expected a local Codex endpoint.");
            string token = File.ReadAllText(Environment.GetEnvironmentVariable("MYIDE_CODEX_BRIDGE_TOKEN")).Trim();
            socket.Options.Proxy = new WebProxy();
            socket.Options.SetRequestHeader("Authorization", "Bearer " + token);
            using (socket)
            using (var stop = new CancellationTokenSource())
            {
                using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8)))
                    await socket.ConnectAsync(url, timeout.Token);
                Task input = Task.Run(() => ReadInput(stop.Token));
                Task output = ReadOutput(stop.Token);
                Task ended = await Task.WhenAny(input, output);
                await ended;
                stop.Cancel();
                return 0;
            }
        }

        async Task ReadInput(CancellationToken stop)
        {
            var input = new StreamReader(Console.OpenStandardInput(), Utf8);
            string line;
            while (!stop.IsCancellationRequested && (line = await input.ReadLineAsync()) != null)
            {
                if (String.IsNullOrWhiteSpace(line)) continue;
                if (desktop) RememberRequest(line);
                await Send(line, stop);
            }
        }

        async Task ReadOutput(CancellationToken stop)
        {
            var output = new StreamWriter(Console.OpenStandardOutput(), Utf8) { AutoFlush = true };
            var buffer = new byte[32768];
            while (!stop.IsCancellationRequested)
            {
                using (var frame = new MemoryStream())
                {
                    WebSocketReceiveResult chunk;
                    do
                    {
                        chunk = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), stop);
                        if (chunk.MessageType == WebSocketMessageType.Close) return;
                        if (chunk.MessageType != WebSocketMessageType.Text)
                            throw new IOException("Invalid Codex message frame.");
                        frame.Write(buffer, 0, chunk.Count);
                    } while (!chunk.EndOfMessage);

                    string line = Utf8.GetString(frame.GetBuffer(), 0, (int)frame.Length);
                    if (desktop)
                    {
                        string supplement;
                        if (!InspectReply(line, out supplement)) continue;
                        if (supplement != null) await Send(supplement, stop);
                    }
                    await output.WriteLineAsync(line);
                }
            }
        }

        async Task Send(string line, CancellationToken stop)
        {
            var bytes = new ArraySegment<byte>(Utf8.GetBytes(line));
            await sendLock.WaitAsync(stop);
            try { await socket.SendAsync(bytes, WebSocketMessageType.Text, true, stop); }
            finally { sendLock.Release(); }
        }

        static object Get(object value, string key)
        {
            var fields = value as IDictionary<string, object>;
            object found;
            return fields != null && fields.TryGetValue(key, out found) ? found : null;
        }

        static string Text(object value, string key) { return Get(value, key) as string; }

        static string Id(object message)
        {
            object id = Get(message, "id");
            if (id == null) return null;
            return id is string ? "s:" + id : "n:" + id;
        }

        void RememberRequest(string line)
        {
            lock (json)
            {
                object message = json.DeserializeObject(line);
                string method = Text(message, "method");
                string id = Id(message);
                object parameters = Get(message, "params");
                string threadId = Text(parameters, "threadId");
                if (id == null || threadId == null) return;
                if (method == "thread/read" || method == "thread/resume" || method == "thread/turns/list")
                    reads[id] = new HistoryRead { ThreadId = threadId, Revision = revision };
                string turnId;
                string effort = Text(parameters, "effort");
                if (method == "thread/settings/update" && effort != null && activeTurns.TryGetValue(threadId, out turnId))
                    efforts[id] = new EffortUpdate { threadId = threadId, turnId = turnId, effort = effort };
            }
        }

        bool InspectReply(string line, out string supplement)
        {
            lock (json)
            {
                supplement = null;
                object message = json.DeserializeObject(line);
                string method = Text(message, "method");
                string id = method == null ? Id(message) : null;
                if (id != null && relayed.Remove(id)) return false;
                object parameters = Get(message, "params");
                string threadId = Text(parameters, "threadId");
                string turnId = Text(Get(parameters, "turn"), "id");
                if (threadId != null && turnId != null && (method == "turn/started" || method == "turn/completed"))
                {
                    revision++;
                    if (method == "turn/started") activeTurns[threadId] = turnId;
                    else if (activeTurns.ContainsKey(threadId) && activeTurns[threadId] == turnId) activeTurns.Remove(threadId);
                }
                if (id == null) return true;

                HistoryRead read;
                if (reads.TryGetValue(id, out read))
                {
                    reads.Remove(id);
                    var result = Get(message, "result");
                    var turns = (Get(Get(result, "thread"), "turns") ?? Get(result, "data")) as IEnumerable;
                    if (read.Revision == revision && turns != null && !activeTurns.ContainsKey(read.ThreadId))
                        foreach (object turn in turns)
                            if (Text(turn, "status") == "inProgress" && Text(turn, "id") != null)
                            {
                                activeTurns[read.ThreadId] = Text(turn, "id");
                                break;
                            }
                }

                // Desktop persists the selected effort for later turns. Apply it
                // to the turn that was active when the user selected it as well.
                EffortUpdate update;
                if (efforts.TryGetValue(id, out update))
                {
                    efforts.Remove(id);
                    string current;
                    if (Get(message, "error") == null &&
                        activeTurns.TryGetValue(update.threadId, out current) && current == update.turnId)
                    {
                        string rpcId = "myide-live-effort-" + Guid.NewGuid().ToString("N");
                        relayed.Add("s:" + rpcId);
                        supplement = json.Serialize(new { id = rpcId, method = "turn/settings/update", @params = update });
                    }
                }
                return true;
            }
        }
    }
}
