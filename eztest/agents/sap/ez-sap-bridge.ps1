<#
  EZTest SAP GUI bridge (protocol ez-agent/1, agent "sap").

  A small Windows-side shim between EZTest and SAP GUI Scripting, SAP's own
  scripting API (COM). Run it on the Windows machine where SAP GUI for Windows
  is installed and scripting is enabled (RZ11 sapgui/user_scripting = TRUE and
  SAP GUI Options > Accessibility & Scripting > Enable scripting):

    powershell -ExecutionPolicy Bypass -File ez-sap-bridge.ps1 -Port 8765 -Token <secret>

  It listens on http://127.0.0.1:<Port>/v1/rpc only, and every request must
  carry the header X-EZ-Agent-Token. It uses no third-party automation tool.

  STATUS: written against the documented SAP GUI Scripting API; not executed in
  EZTest's CI (no SAP system there). EZTest's TypeScript side is tested against
  a simulator of this protocol.
#>
param(
  [int]$Port = 8765,
  [string]$Token = $env:EZ_AGENT_TOKEN
)

$ErrorActionPreference = 'Stop'
if (-not $Token) { throw 'Set -Token (or EZ_AGENT_TOKEN): the bridge refuses to run without one.' }

$script:session = $null

function Get-Engine {
  $rot = New-Object -ComObject SapROTWr.SapROTWrapper
  $gui = $rot.GetROTEntry('SAPGUI')
  if (-not $gui) { throw 'SAP GUI is not running (start SAP Logon first).' }
  return $gui.GetType().InvokeMember('GetScriptingEngine', [Reflection.BindingFlags]::InvokeMethod, $null, $gui, $null)
}

function Need-Session {
  if (-not $script:session) { throw 'no SAP session: call open first' }
  return $script:session
}

function Find($id) {
  $s = Need-Session
  try { return $s.findById($id) } catch { throw "no SAP element $id on this screen" }
}

function Describe($c) {
  $d = [ordered]@{ id = ($c.Id -replace '^/app/con\[\d+\]/ses\[\d+\]/', ''); type = $c.Type; name = $c.Name }
  try { if ($c.Text) { $d.text = [string]$c.Text } } catch {}
  try { if ($c.Tooltip) { $d.tooltip = [string]$c.Tooltip } } catch {}
  try { if ($c.LeftLabel) { $d.leftLabel = [string]$c.LeftLabel.Text } } catch {}
  try { $d.changeable = [bool]$c.Changeable } catch {}
  try { if ($c.Type -in 'GuiCheckBox', 'GuiRadioButton') { $d.selected = [bool]$c.Selected } } catch {}
  try { $d.rect = [ordered]@{ x = $c.ScreenLeft; y = $c.ScreenTop; width = $c.Width; height = $c.Height } } catch {}
  if ($c.Type -eq 'GuiTableControl') {
    $cols = @(); for ($i = 0; $i -lt $c.Columns.Count; $i++) { $cols += [string]$c.Columns.ElementAt($i).Title }; $d.columns = $cols
  }
  if ($c.Type -eq 'GuiShell' -and $c.SubType -eq 'GridView') {
    $cols = @(); foreach ($n in $c.ColumnOrder) { $cols += [string]$c.GetColumnTitles($n)[0] }; $d.columns = $cols
  }
  return $d
}

function Walk($c, $list, $depth) {
  if ($list.Count -ge 3000 -or $depth -gt 12) { return }
  $list.Add((Describe $c)) | Out-Null
  $kids = $null
  try { $kids = $c.Children } catch {}
  if ($kids -and $c.Type -ne 'GuiTableControl') {
    for ($i = 0; $i -lt $kids.Count; $i++) { Walk $kids.ElementAt($i) $list ($depth + 1) }
  }
}

function Status {
  $sb = (Need-Session).findById('wnd[0]/sbar')
  return [ordered]@{ type = [string]$sb.MessageType; text = [string]$sb.Text; id = [string]$sb.MessageId; number = [string]$sb.MessageNumber }
}

function Cell($p) {
  $t = Find $p.id
  $row = [int]$p.row - 1
  if ($t.Type -eq 'GuiTableControl') {
    $col = -1
    for ($i = 0; $i -lt $t.Columns.Count; $i++) { if ($t.Columns.ElementAt($i).Title -eq $p.column -or [string]($i + 1) -eq $p.column) { $col = $i } }
    if ($col -lt 0) { throw "no column $($p.column)" }
    $cell = $t.GetCell($row, $col)
    if ($null -ne $p.value) { $cell.Text = [string]$p.value }
    return [ordered]@{ value = [string]$cell.Text }
  }
  # ALV grid (GuiGridView)
  $colName = $null
  foreach ($n in $t.ColumnOrder) { if ($t.GetColumnTitles($n)[0] -eq $p.column -or $n -eq $p.column) { $colName = $n } }
  if (-not $colName) { throw "no column $($p.column)" }
  if ($null -ne $p.value) { $t.ModifyCell($row, $colName, [string]$p.value) }
  return [ordered]@{ value = [string]$t.GetCellValue($row, $colName) }
}

function Call($method, $p) {
  switch ($method) {
    'hello' { return [ordered]@{ agent = 'sap'; protocol = 'ez-agent/1'; version = '0.1.0'; platform = 'SAP GUI Scripting' } }
    'open' {
      $engine = Get-Engine
      $con = $null
      for ($i = 0; $i -lt $engine.Children.Count; $i++) { $c = $engine.Children.ElementAt($i); if ($c.Description -eq $p.connection) { $con = $c } }
      if (-not $con) { $con = $engine.OpenConnection($p.connection, $true) }
      $script:session = $con.Children.ElementAt(0)
      return [ordered]@{ session = $script:session.Id }
    }
    'login' {
      $s = Need-Session
      if ($p.client) { $s.findById('wnd[0]/usr/txtRSYST-MANDT').Text = [string]$p.client }
      $s.findById('wnd[0]/usr/txtRSYST-BNAME').Text = [string]$p.user
      $s.findById('wnd[0]/usr/pwdRSYST-BCODE').Text = [string]$p.password
      if ($p.language) { $s.findById('wnd[0]/usr/txtRSYST-LANGU').Text = [string]$p.language }
      $s.findById('wnd[0]').sendVKey(0)
      return (Status)
    }
    'transaction' { (Need-Session).StartTransaction([string]$p.code); return @{} }
    'dump' {
      $s = Need-Session
      $w = $s.findById('wnd[0]')
      $list = New-Object System.Collections.ArrayList
      foreach ($area in 'wnd[0]/usr', 'wnd[0]/tbar[1]', 'wnd[0]/tbar[0]') { try { Walk ($s.findById($area)) $list 0 } catch {} }
      for ($k = 1; $k -lt 4; $k++) { try { Walk ($s.findById("wnd[$k]")) $list 0 } catch {} }
      return [ordered]@{ window = [ordered]@{ id = 'wnd[0]'; title = [string]$w.Text; transaction = [string]$s.Info.Transaction; program = [string]$s.Info.Program; screen = [int]$s.Info.ScreenNumber }; elements = $list }
    }
    'get' {
      $c = Find $p.id
      if ($c.Type -eq 'GuiComboBox') { return [ordered]@{ value = [string]$c.Value } }
      if ($c.Type -in 'GuiCheckBox', 'GuiRadioButton') { return [ordered]@{ value = [string]$c.Selected } }
      return [ordered]@{ value = [string]$c.Text }
    }
    'set' {
      $c = Find $p.id
      if ($c.Type -eq 'GuiComboBox') {
        $key = $null
        foreach ($e in $c.Entries) { if ($e.Value -eq $p.value -or $e.Key -eq $p.value) { $key = $e.Key } }
        if (-not $key) { throw "no entry $($p.value) in $($p.id)" }
        $c.Key = $key
      } elseif ($c.Type -in 'GuiCheckBox') { $c.Selected = ([string]$p.value -in 'true', 'X', '1', 'yes') }
      else { $c.Text = [string]$p.value }
      return @{}
    }
    'press' { (Find $p.id).press(); return @{} }
    'select' {
      $c = Find $p.id
      if ($c.Type -eq 'GuiCheckBox' -and $null -ne $p.selected) { $c.Selected = [bool]$p.selected } else { $c.select() }
      return @{}
    }
    'vkey' { (Need-Session).findById('wnd[0]').sendVKey([int]$p.key); return @{} }
    'status' { return (Status) }
    'cell' { return (Cell $p) }
    'screenshot' {
      $file = [IO.Path]::Combine([IO.Path]::GetTempPath(), "ez-sap-$([guid]::NewGuid()).png")
      (Need-Session).findById('wnd[0]').HardCopy($file, 2) | Out-Null
      $b = [IO.File]::ReadAllBytes($file); Remove-Item $file
      return [ordered]@{ png = [Convert]::ToBase64String($b) }
    }
    'close' { $script:session = $null; return @{} }
    default { throw "unknown method $method" }
  }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/v1/")
$listener.Start()
Write-Host "ez-sap-bridge listening on http://127.0.0.1:$Port"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $status = 200
  try {
    $got = $ctx.Request.Headers['x-ez-agent-token']
    if ($got -ne $Token) { $status = 401; $out = [ordered]@{ ok = $false; error = [ordered]@{ code = 'unauthorized'; message = 'missing or wrong X-EZ-Agent-Token' } } }
    else {
      $body = (New-Object IO.StreamReader($ctx.Request.InputStream, [Text.Encoding]::UTF8)).ReadToEnd()
      $req = $body | ConvertFrom-Json
      $out = [ordered]@{ ok = $true; result = (Call $req.method $req.params) }
    }
  } catch {
    $out = [ordered]@{ ok = $false; error = [ordered]@{ code = 'error'; message = $_.Exception.Message } }
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($out | ConvertTo-Json -Depth 12 -Compress))
  $ctx.Response.StatusCode = $status
  $ctx.Response.ContentType = 'application/json; charset=utf-8'
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $ctx.Response.Close()
}
