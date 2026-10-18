param(
  [string]$GameDir = 'D:\Program Files\Arknights Endfield',
  [string]$LauncherRoot = 'D:\Program Files\Hypergryph Launcher',
  [string]$GameArgs = ''
)
# Launch Endfield.exe with the official Games.exe as its (suspended) parent,
# satisfying the Endfield 1.6+ launch check (U8SDK requires parent == official Games.exe).
# Technique ported from Xel-Launcher ParentProcessLauncher.cs (Apache-2.0).
# ASCII-only file: Windows PowerShell 5.1 reads .ps1 as ANSI unless UTF-8 BOM present.

$ErrorActionPreference = 'Stop'

# Resolve Games.exe from the newest version folder under the launcher root
$gamesExe = Get-ChildItem -Path $LauncherRoot -Recurse -Filter 'Games.exe' -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $gamesExe) { throw "Games.exe not found under $LauncherRoot" }
$gameExe = Join-Path $GameDir 'Endfield.exe'
if (-not (Test-Path $gameExe)) { throw "Endfield.exe not found: $gameExe" }

$src = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ParentLaunch
{
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x08000000;
    static readonly UIntPtr PROC_THREAD_ATTRIBUTE_PARENT_PROCESS = (UIntPtr)0x00020000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(
        string lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessExW(
        string lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(
        IntPtr lpAttributeList, int dwAttributeCount, uint dwFlags, ref UIntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(
        IntPtr lpAttributeList, uint dwFlags, UIntPtr Attribute,
        IntPtr lpValue, UIntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    // Creates the official Games.exe in a suspended state; it is never resumed.
    // Returns its process handle (must stay alive while the game runs).
    public static IntPtr StartSuspended(string executable)
    {
        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        var cmd = new StringBuilder("\"" + executable + "\"");
        PROCESS_INFORMATION pi;
        if (!CreateProcessW(executable, cmd, IntPtr.Zero, IntPtr.Zero, false,
                CREATE_SUSPENDED, IntPtr.Zero, System.IO.Path.GetDirectoryName(executable),
                ref si, out pi))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "failed to create suspended Games.exe");
        CloseHandle(pi.hThread);
        return pi.hProcess;
    }

    // Creates the game with the suspended Games.exe as its parent process.
    // Returns the new game pid.
    public static int StartWithParent(IntPtr parent, string executable, string arguments, string directory)
    {
        string cmdLine = "\"" + executable + "\"" +
            (string.IsNullOrWhiteSpace(arguments) ? "" : " " + arguments);
        var cmd = new StringBuilder(cmdLine);

        IntPtr list = IntPtr.Zero, value = IntPtr.Zero;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        try
        {
            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == UIntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "attribute list size query failed");
            list = Marshal.AllocHGlobal((int)size);
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref size))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList failed");
            value = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(value, parent);
            if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
                    value, (UIntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute failed");

            var siex = new STARTUPINFOEX();
            siex.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            siex.lpAttributeList = list;

            if (!CreateProcessExW(executable, cmd, IntPtr.Zero, IntPtr.Zero, false,
                    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                    IntPtr.Zero, directory, ref siex, out pi))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess for Endfield.exe failed");
            return pi.dwProcessId;
        }
        finally
        {
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            if (list != IntPtr.Zero) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
        }
    }

    public static void Terminate(IntPtr hProcess)
    {
        if (hProcess == IntPtr.Zero) return;
        TerminateProcess(hProcess, 0);
        CloseHandle(hProcess);
    }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

Write-Output ("parent: " + $gamesExe.FullName)
Write-Output ("game:   " + $gameExe)

$parentHandle = [ParentLaunch]::StartSuspended($gamesExe.FullName)
try {
  $gamePid = [ParentLaunch]::StartWithParent($parentHandle, $gameExe, $GameArgs, $GameDir)
  Write-Output ("launched Endfield.exe pid=" + $gamePid)
} catch {
  [ParentLaunch]::Terminate($parentHandle)
  throw
}

# Keep the suspended parent alive for the whole game session (game check may re-run),
# then clean up when the game exits.
try {
  $gameProc = [System.Diagnostics.Process]::GetProcessById($gamePid)
  $gameProc.WaitForExit()
  Write-Output ("game exited pid=" + $gamePid)
} catch {
  Write-Output ("game process gone pid=" + $gamePid)
} finally {
  [ParentLaunch]::Terminate($parentHandle)
  Write-Output 'parent terminated'
}
