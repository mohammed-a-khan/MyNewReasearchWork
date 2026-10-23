// Keyboard and mouse input through Win32 SendInput (part of Windows).
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace EzTest.WindowsAgent;

static class Win32
{
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    public static void SetForeground(AutomationElement w)
    {
        var h = new IntPtr(w.Current.NativeWindowHandle);
        if (h == IntPtr.Zero) throw new AgentException("no-window", "the element is not a native window");
        ShowWindow(h, 9); // SW_RESTORE
        SetForegroundWindow(h);
    }
}

static class Input
{
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern short VkKeyScan(char ch);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
    const uint LEFTDOWN = 0x2, LEFTUP = 0x4, RIGHTDOWN = 0x8, RIGHTUP = 0x10, MIDDLEDOWN = 0x20, MIDDLEUP = 0x40;

    static readonly Dictionary<string, ushort> Vk = new()
    {
        ["ENTER"] = 0x0D, ["TAB"] = 0x09, ["ESCAPE"] = 0x1B, ["BACKSPACE"] = 0x08, ["DELETE"] = 0x2E, ["SPACE"] = 0x20,
        ["UP"] = 0x26, ["DOWN"] = 0x28, ["LEFT"] = 0x25, ["RIGHT"] = 0x27, ["HOME"] = 0x24, ["END"] = 0x23,
        ["PAGEUP"] = 0x21, ["PAGEDOWN"] = 0x22, ["INSERT"] = 0x2D, ["CTRL"] = 0x11, ["ALT"] = 0x12, ["SHIFT"] = 0x10, ["WIN"] = 0x5B,
    };

    static ushort VkOf(string k)
    {
        if (Vk.TryGetValue(k, out var v)) return v;
        if (k.Length >= 2 && k[0] == 'F' && int.TryParse(k[1..], out var f) && f is >= 1 and <= 24) return (ushort)(0x70 + f - 1);
        if (k.Length == 1) return (ushort)(VkKeyScan(k[0]) & 0xff);
        throw new AgentException("invalid-argument", $"unknown key {k}");
    }

    static INPUT Key(ushort vk, bool up) => new() { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? KEYEVENTF_KEYUP : 0 } } };

    static void Send(List<INPUT> inputs)
    {
        if (inputs.Count == 0) return;
        if (SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf<INPUT>()) != inputs.Count)
            throw new AgentException("error", "SendInput was blocked (is the desktop locked, or a higher-integrity window in front?)");
    }

    /** Press keys together, release in reverse order: ["CTRL", "S"]. */
    public static void Chord(List<string> keys)
    {
        var vks = keys.Select(VkOf).ToList();
        var inputs = vks.Select(v => Key(v, false)).ToList();
        inputs.AddRange(Enumerable.Reverse(vks).Select(v => Key(v, true)));
        Send(inputs);
    }

    public static void Text(string text)
    {
        var inputs = new List<INPUT>();
        foreach (var ch in text)
        {
            inputs.Add(new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wScan = ch, dwFlags = KEYEVENTF_UNICODE } } });
            inputs.Add(new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wScan = ch, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } });
        }
        Send(inputs);
    }

    public static void Click(int x, int y, string button, bool twice)
    {
        SetCursorPos(x, y);
        var (down, up) = button switch { "right" => (RIGHTDOWN, RIGHTUP), "middle" => (MIDDLEDOWN, MIDDLEUP), _ => (LEFTDOWN, LEFTUP) };
        var one = new[]
        {
            new INPUT { type = INPUT_MOUSE, U = new InputUnion { mi = new MOUSEINPUT { dwFlags = down } } },
            new INPUT { type = INPUT_MOUSE, U = new InputUnion { mi = new MOUSEINPUT { dwFlags = up } } },
        };
        var all = new List<INPUT>(one);
        if (twice) all.AddRange(one);
        Send(all);
    }
}
