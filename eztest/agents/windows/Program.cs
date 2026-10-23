// EZTest Windows agent: serves protocol ez-agent/1 (POST /v1/rpc) on 127.0.0.1.
// Usage: ez-windows-agent.exe [--port 47123] [--host 127.0.0.1] [--token SECRET]
//        (the token may also come from the EZ_AGENT_TOKEN environment variable)
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace EzTest.WindowsAgent;

public static class Program
{
    public const string Protocol = "ez-agent/1";
    public const string Version = "0.1.0";

    [STAThread]
    public static int Main(string[] args)
    {
        string host = "127.0.0.1";
        int port = 47123;
        string? token = Environment.GetEnvironmentVariable("EZ_AGENT_TOKEN");
        for (int i = 0; i < args.Length - 1; i++)
        {
            switch (args[i])
            {
                case "--port": port = int.Parse(args[++i]); break;
                case "--host": host = args[++i]; break;
                case "--token": token = args[++i]; break;
            }
        }
        if (host != "127.0.0.1" && host != "localhost" && string.IsNullOrEmpty(token))
        {
            Console.Error.WriteLine("Refusing to listen on a non-loopback address without --token.");
            return 2;
        }
        var listener = new HttpListener();
        listener.Prefixes.Add($"http://{host}:{port}/v1/");
        listener.Start();
        Console.Error.WriteLine($"ez-windows-agent {Version} listening on http://{host}:{port}");
        var agent = new UiaAgent();
        while (listener.IsListening)
        {
            var ctx = listener.GetContext();
            ThreadPool.QueueUserWorkItem(_ => Handle(ctx, token, agent));
        }
        return 0;
    }

    static bool TokenOk(string? expected, string? got)
    {
        if (string.IsNullOrEmpty(expected)) return true;
        if (got is null) return false;
        return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(got));
    }

    static void Handle(HttpListenerContext ctx, string? token, UiaAgent agent)
    {
        var res = ctx.Response;
        var output = new Dictionary<string, object?>();
        int status = 200;
        try
        {
            if (ctx.Request.HttpMethod != "POST" || ctx.Request.Url?.AbsolutePath != "/v1/rpc")
            {
                status = 404;
                output["ok"] = false;
                output["error"] = Err("not-found", "POST /v1/rpc");
            }
            else if (!TokenOk(token, ctx.Request.Headers["x-ez-agent-token"]))
            {
                status = 401;
                output["ok"] = false;
                output["error"] = Err("unauthorized", "missing or wrong X-EZ-Agent-Token");
            }
            else
            {
                using var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8);
                using var doc = JsonDocument.Parse(reader.ReadToEnd());
                var method = doc.RootElement.GetProperty("method").GetString() ?? "";
                var p = doc.RootElement.TryGetProperty("params", out var pe) ? pe : default;
                output["ok"] = true;
                output["result"] = agent.Call(method, p);
            }
        }
        catch (AgentException e)
        {
            output.Clear();
            output["ok"] = false;
            output["error"] = Err(e.Code, e.Message);
        }
        catch (Exception e)
        {
            output.Clear();
            output["ok"] = false;
            output["error"] = Err("error", $"{e.GetType().Name}: {e.Message}");
        }
        var body = JsonSerializer.SerializeToUtf8Bytes(output, new JsonSerializerOptions { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });
        res.StatusCode = status;
        res.ContentType = "application/json; charset=utf-8";
        res.ContentLength64 = body.Length;
        res.OutputStream.Write(body);
        res.OutputStream.Close();
    }

    static Dictionary<string, object?> Err(string code, string message) => new() { ["code"] = code, ["message"] = message };
}

public sealed class AgentException : Exception
{
    public string Code { get; }
    public AgentException(string code, string message) : base(message) { Code = code; }
}
