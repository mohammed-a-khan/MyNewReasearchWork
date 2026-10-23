// The UI Automation side of the EZTest Windows agent (protocol ez-agent/1).
// Elements are reported with UI Automation control type names; EZTest's
// TypeScript side does the matching, healing and evidence.
using System.Diagnostics;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Text.Json;
using System.Windows.Automation;

namespace EzTest.WindowsAgent;

public sealed class UiaAgent
{
    const int MaxElements = 5000;
    readonly Dictionary<string, AutomationElement> byId = new();
    readonly object gate = new();

    static string IdOf(AutomationElement e) => "r" + string.Join(".", e.GetRuntimeId());

    string Register(AutomationElement e)
    {
        var id = IdOf(e);
        byId[id] = e;
        return id;
    }

    AutomationElement El(JsonElement p, string key = "id")
    {
        var id = Str(p, key) ?? throw new AgentException("invalid-argument", $"missing {key}");
        if (!byId.TryGetValue(id, out var e)) throw new AgentException("stale", $"element {id} is unknown (refresh the elements)");
        try
        {
            _ = e.Current.ControlType; // throws ElementNotAvailableException when gone
        }
        catch (ElementNotAvailableException)
        {
            byId.Remove(id);
            throw new AgentException("stale", $"element {id} no longer exists");
        }
        return e;
    }

    static string? Str(JsonElement p, string key) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(key, out var v) ? (v.ValueKind == JsonValueKind.String ? v.GetString() : v.ToString()) : null;

    static double Num(JsonElement p, string key) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble()
        : double.TryParse(Str(p, key), out var d) ? d : throw new AgentException("invalid-argument", $"missing number {key}");

    public object? Call(string method, JsonElement p)
    {
        lock (gate)
        {
            return method switch
            {
                "hello" => new Dictionary<string, object?> { ["agent"] = "windows", ["protocol"] = Program.Protocol, ["version"] = Program.Version, ["platform"] = Environment.OSVersion.VersionString },
                "windows" => new Dictionary<string, object?> { ["windows"] = Windows() },
                "launch" => Launch(p),
                "activate" => Do(() => Win32.SetForeground(El(p, "window"))),
                "closeWindow" => Do(() => Pattern<WindowPattern>(El(p, "window"), WindowPattern.Pattern, "close").Close()),
                "elements" => Elements(El(p, "window")),
                "invoke" => Do(() => Invoke(El(p))),
                "setValue" => Do(() => SetValue(El(p), Str(p, "value") ?? "")),
                "getValue" => new Dictionary<string, object?> { ["value"] = GetValue(El(p)) },
                "toggle" => Do(() => Toggle(El(p), Str(p, "state"))),
                "expand" => Do(() => Pattern<ExpandCollapsePattern>(El(p), ExpandCollapsePattern.Pattern, "expand").Expand()),
                "collapse" => Do(() => Pattern<ExpandCollapsePattern>(El(p), ExpandCollapsePattern.Pattern, "collapse").Collapse()),
                "select" => Do(() => Pattern<SelectionItemPattern>(El(p), SelectionItemPattern.Pattern, "select").Select()),
                "focus" => Do(() => El(p).SetFocus()),
                "keys" => Do(() => { if (Str(p, "id") is not null) El(p).SetFocus(); Input.Chord(Keys(p)); }),
                "typeText" => Do(() => { if (Str(p, "id") is not null) El(p).SetFocus(); Input.Text(Str(p, "text") ?? ""); }),
                "mouse" => Do(() => Input.Click((int)Num(p, "x"), (int)Num(p, "y"), Str(p, "button") ?? "left", p.TryGetProperty("double", out var d) && d.ValueKind == JsonValueKind.True)),
                "screenshot" => new Dictionary<string, object?> { ["png"] = Screenshot(Str(p, "window") is null ? null : El(p, "window")) },
                "cell" => new Dictionary<string, object?> { ["value"] = Cell(El(p), (int)Num(p, "row"), Str(p, "column") ?? "", Str(p, "value")) },
                "treePath" => Do(() => TreePath(El(p), p.GetProperty("path").EnumerateArray().Select(x => x.GetString() ?? "").ToList(), Str(p, "op") ?? "select")),
                _ => throw new AgentException("unknown-method", $"unknown method {method}"),
            };
        }
    }

    static Dictionary<string, object?> Do(Action a)
    {
        a();
        return new();
    }

    static T Pattern<T>(AutomationElement e, AutomationPattern pattern, string what) where T : BasePattern
    {
        if (e.TryGetCurrentPattern(pattern, out var o)) return (T)o;
        throw new AgentException("not-supported", $"{TypeName(e)} \"{e.Current.Name}\" does not support {what}");
    }

    static string TypeName(AutomationElement e) => e.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");

    List<Dictionary<string, object?>> Windows()
    {
        var list = new List<Dictionary<string, object?>>();
        foreach (AutomationElement w in AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition))
        {
            list.Add(new() { ["id"] = Register(w), ["title"] = w.Current.Name, ["pid"] = w.Current.ProcessId, ["className"] = w.Current.ClassName });
        }
        return list;
    }

    Dictionary<string, object?> Launch(JsonElement p)
    {
        var app = Str(p, "app") ?? throw new AgentException("invalid-argument", "missing app");
        var timeout = p.TryGetProperty("timeoutMs", out var t) && t.ValueKind == JsonValueKind.Number ? t.GetInt32() : 30000;
        var before = new HashSet<string>(Windows().Select(w => (string)w["id"]!));
        Process? proc;
        if (app.Contains('!') && !app.Contains('\\'))
        {
            // A UWP app user model id: started through the shell.
            proc = Process.Start(new ProcessStartInfo("explorer.exe", $"shell:AppsFolder\\{app}") { UseShellExecute = true });
            proc = null;
        }
        else
        {
            proc = Process.Start(new ProcessStartInfo(app, Str(p, "args") ?? "") { UseShellExecute = true, WorkingDirectory = Str(p, "workingDir") ?? "" });
        }
        var deadline = DateTime.UtcNow.AddMilliseconds(timeout);
        while (DateTime.UtcNow < deadline)
        {
            foreach (var w in Windows())
            {
                var mine = proc is not null ? Convert.ToInt32(w["pid"]) == proc.Id : !before.Contains((string)w["id"]!);
                if (mine && !string.IsNullOrEmpty((string?)w["title"])) return new() { ["window"] = w };
            }
            // Apps that hand off to another process (launchers): any new window counts.
            foreach (var w in Windows()) if (!before.Contains((string)w["id"]!) && !string.IsNullOrEmpty((string?)w["title"])) return new() { ["window"] = w };
            Thread.Sleep(200);
        }
        throw new AgentException("timeout", $"{app} showed no window within {timeout}ms");
    }

    Dictionary<string, object?> Elements(AutomationElement window)
    {
        var list = new List<Dictionary<string, object?>>();
        var walker = TreeWalker.ControlViewWalker;
        void Walk(AutomationElement e, string? parent)
        {
            if (list.Count >= MaxElements) return;
            Dictionary<string, object?> info;
            try { info = Describe(e, parent); } catch (ElementNotAvailableException) { return; }
            list.Add(info);
            var child = walker.GetFirstChild(e);
            while (child is not null)
            {
                Walk(child, (string)info["id"]!);
                child = walker.GetNextSibling(child);
            }
        }
        Walk(window, null);
        return new() { ["elements"] = list, ["truncated"] = list.Count >= MaxElements ? true : null };
    }

    Dictionary<string, object?> Describe(AutomationElement e, string? parent)
    {
        var c = e.Current;
        var d = new Dictionary<string, object?>
        {
            ["id"] = Register(e),
            ["parent"] = parent,
            ["controlType"] = TypeName(e),
            ["name"] = string.IsNullOrEmpty(c.Name) ? null : c.Name,
            ["automationId"] = string.IsNullOrEmpty(c.AutomationId) ? null : c.AutomationId,
            ["className"] = string.IsNullOrEmpty(c.ClassName) ? null : c.ClassName,
            ["framework"] = string.IsNullOrEmpty(c.FrameworkId) ? null : c.FrameworkId,
            ["enabled"] = c.IsEnabled,
            ["visible"] = !c.IsOffscreen,
        };
        try { if (c.LabeledBy is { } lb && !string.IsNullOrEmpty(lb.Current.Name)) d["labeledBy"] = lb.Current.Name; } catch (ElementNotAvailableException) { }
        if (!c.IsPassword && e.TryGetCurrentPattern(ValuePattern.Pattern, out var vp)) d["value"] = ((ValuePattern)vp).Current.Value;
        if (e.TryGetCurrentPattern(TogglePattern.Pattern, out var tp))
            d["toggle"] = ((TogglePattern)tp).Current.ToggleState switch { ToggleState.On => "on", ToggleState.Off => "off", _ => "indeterminate" };
        if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var ep)) d["expanded"] = ((ExpandCollapsePattern)ep).Current.ExpandCollapseState == ExpandCollapseState.Expanded;
        if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var sp)) d["selected"] = ((SelectionItemPattern)sp).Current.IsSelected;
        var r = c.BoundingRectangle;
        if (!r.IsEmpty && !double.IsInfinity(r.X)) d["rect"] = new Dictionary<string, object?> { ["x"] = (int)r.X, ["y"] = (int)r.Y, ["width"] = (int)r.Width, ["height"] = (int)r.Height };
        return d;
    }

    static void Invoke(AutomationElement e)
    {
        if (!e.Current.IsEnabled) throw new AgentException("disabled", $"{TypeName(e)} \"{e.Current.Name}\" is disabled");
        if (e.TryGetCurrentPattern(InvokePattern.Pattern, out var ip)) { ((InvokePattern)ip).Invoke(); return; }
        if (e.TryGetCurrentPattern(TogglePattern.Pattern, out var tp)) { ((TogglePattern)tp).Toggle(); return; }
        if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var sp)) { ((SelectionItemPattern)sp).Select(); return; }
        if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var ep)) { ((ExpandCollapsePattern)ep).Expand(); return; }
        var r = e.Current.BoundingRectangle;
        if (r.IsEmpty) throw new AgentException("not-supported", $"{TypeName(e)} \"{e.Current.Name}\" cannot be invoked and has no position");
        Input.Click((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), "left", false);
    }

    static void SetValue(AutomationElement e, string value)
    {
        if (!e.Current.IsEnabled) throw new AgentException("disabled", $"{TypeName(e)} \"{e.Current.Name}\" is disabled");
        if (e.TryGetCurrentPattern(ValuePattern.Pattern, out var vp))
        {
            var v = (ValuePattern)vp;
            if (v.Current.IsReadOnly) throw new AgentException("read-only", $"{TypeName(e)} \"{e.Current.Name}\" is read-only");
            v.SetValue(value);
            return;
        }
        // Controls without ValuePattern: focus, select all, type.
        e.SetFocus();
        Input.Chord(new List<string> { "CTRL", "A" });
        Input.Chord(new List<string> { "DELETE" });
        Input.Text(value);
    }

    static string GetValue(AutomationElement e)
    {
        if (e.TryGetCurrentPattern(ValuePattern.Pattern, out var vp)) return ((ValuePattern)vp).Current.Value ?? "";
        if (e.TryGetCurrentPattern(TextPattern.Pattern, out var tp)) return ((TextPattern)tp).DocumentRange.GetText(-1).TrimEnd('\r', '\n');
        if (e.TryGetCurrentPattern(SelectionPattern.Pattern, out var sp))
        {
            var sel = ((SelectionPattern)sp).Current.GetSelection();
            if (sel.Length > 0) return sel[0].Current.Name;
        }
        return e.Current.Name ?? "";
    }

    static void Toggle(AutomationElement e, string? state)
    {
        var t = Pattern<TogglePattern>(e, TogglePattern.Pattern, "toggle");
        if (state is null) { t.Toggle(); return; }
        var want = state == "on" ? ToggleState.On : ToggleState.Off;
        for (int i = 0; i < 3 && t.Current.ToggleState != want; i++) t.Toggle();
        if (t.Current.ToggleState != want) throw new AgentException("error", $"could not set {TypeName(e)} \"{e.Current.Name}\" {state}");
    }

    static string Screenshot(AutomationElement? window)
    {
        Rectangle r;
        if (window is null) r = System.Windows.Forms.SystemInformation.VirtualScreen;
        else
        {
            var b = window.Current.BoundingRectangle;
            r = new Rectangle((int)b.X, (int)b.Y, Math.Max(1, (int)b.Width), Math.Max(1, (int)b.Height));
        }
        using var bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.Location, Point.Empty, r.Size);
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return Convert.ToBase64String(ms.ToArray());
    }

    static string Cell(AutomationElement grid, int row, string column, string? set)
    {
        var g = Pattern<GridPattern>(grid, GridPattern.Pattern, "cells");
        int col;
        if (!int.TryParse(column, out col))
        {
            col = -1;
            if (grid.TryGetCurrentPattern(TablePattern.Pattern, out var tp))
            {
                var headers = ((TablePattern)tp).Current.GetColumnHeaders();
                for (int i = 0; i < headers.Length; i++) if (string.Equals(headers[i].Current.Name, column, StringComparison.OrdinalIgnoreCase)) col = i;
            }
            if (col < 0) throw new AgentException("no-cell", $"no column \"{column}\"");
        }
        else col -= 1;
        if (row < 1 || row > g.Current.RowCount) throw new AgentException("no-cell", $"row {row} is outside 1..{g.Current.RowCount}");
        var cell = g.GetItem(row - 1, col);
        if (set is not null) SetValue(cell, set);
        return GetValue(cell);
    }

    static void TreePath(AutomationElement tree, List<string> path, string op)
    {
        AutomationElement node = tree;
        for (int i = 0; i < path.Count; i++)
        {
            var next = node.FindFirst(TreeScope.Children, new AndCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TreeItem),
                new PropertyCondition(AutomationElement.NameProperty, path[i])))
                ?? throw new AgentException("no-element", $"tree has no \"{path[i]}\"");
            bool last = i == path.Count - 1;
            if ((!last || op == "expand") && next.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var ep)) ((ExpandCollapsePattern)ep).Expand();
            if (last && op == "collapse") Pattern<ExpandCollapsePattern>(next, ExpandCollapsePattern.Pattern, "collapse").Collapse();
            if (last && op == "select") Pattern<SelectionItemPattern>(next, SelectionItemPattern.Pattern, "select").Select();
            node = next;
        }
    }

    static List<string> Keys(JsonElement p) => p.GetProperty("keys").EnumerateArray().Select(x => x.GetString() ?? "").ToList();
}
