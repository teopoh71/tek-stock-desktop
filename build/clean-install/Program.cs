using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TekClean {
  public class UninstallJob { public string File, Arguments, Key; }
  public class PendingInstallException : IOException { public PendingInstallException(string text):base(text) {} }
  public class Installer {
    static Process activeInstaller;
    public static List<UninstallJob> FindOldPackages() {
      var result=new List<UninstallJob>(); var seen=new HashSet<string>();
      foreach(var hive in new[]{RegistryHive.LocalMachine,RegistryHive.CurrentUser}) foreach(var view in new[]{RegistryView.Registry64,RegistryView.Registry32}) {
        using(var root=RegistryKey.OpenBaseKey(hive,view)) using(var uninstall=root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall")) {
          if(uninstall==null) continue;
          foreach(var name in uninstall.GetSubKeyNames()) using(var key=uninstall.OpenSubKey(name)) {
            string display=Convert.ToString(key.GetValue("DisplayName"));
            if(!Regex.IsMatch(display,@"^TEK STOCK(?: Singapore)?(?: \d+\.\d+\.\d+(?:\.\d+)?)?$")) continue;
            string command=Convert.ToString(key.GetValue("UninstallString"));
            if(Convert.ToString(key.GetValue("WindowsInstaller"))=="1") {
              Guid code; if(!Guid.TryParse(name,out code)) throw new IOException("旧安装记录异常，未执行卸载。");
              if(seen.Add(code.ToString())) result.Add(new UninstallJob {File=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"msiexec.exe"),Arguments="/x {"+code+"} /qn /norestart",Key=display});
            } else {
              var match=Regex.Match(command,@"^""([^""]+\.exe)""(?:\s|$)",RegexOptions.IgnoreCase);
              if(!match.Success) throw new IOException("旧安装程序路径无法确认，未执行卸载。");
              string file=Path.GetFullPath(match.Groups[1].Value);
              bool allowed=false;
              foreach(var baseDir in new[]{Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs")})
                foreach(var folder in new[]{"TEK STOCK","TEK STOCK Singapore","samlee-inventory-desktop"})
                  if(String.Equals(Path.GetDirectoryName(file),Path.Combine(baseDir,folder),StringComparison.OrdinalIgnoreCase)) allowed=true;
              if(!allowed || !Path.GetFileName(file).StartsWith("Uninstall",StringComparison.OrdinalIgnoreCase)) throw new IOException("旧安装路径超出 TEK STOCK 范围，已停止。");
              if(File.Exists(file) && seen.Add(file)) result.Add(new UninstallJob {File=file,Arguments="/S _?="+Path.GetDirectoryName(file),Key=display});
            }
          }
        }
      }
      return result;
    }
    public static void Run(string file,string arguments) {
      var process=Process.Start(new ProcessStartInfo(file,arguments) {UseShellExecute=true,Verb="runas"});
      activeInstaller=process;
      if(!process.WaitForExit(300000)) throw new PendingInstallException("Windows 安装仍未结束。请等待安装窗口完成后再重试；旧资料备份已保留。");
      activeInstaller=null;
      using(process) {
        if(process.ExitCode!=0 && process.ExitCode!=1605 && process.ExitCode!=1614 && process.ExitCode!=3010)
          throw new IOException("Windows 安装返回错误 "+process.ExitCode+"。可以重试，旧资料备份已保留。");
      }
    }
    public static string Install(Action<string> progress, Action<string> backupNotice) {
      if(activeInstaller!=null && !activeInstaller.HasExited) throw new PendingInstallException("Windows 安装仍在进行，请等待后再重试。");
      if(Environment.Is64BitOperatingSystem==false || Environment.OSVersion.Version.Major<10) throw new IOException("此安装包需要 Windows 10/11 64 位。");
      if(Process.GetProcessesByName("TEK STOCK").Length>0 || Process.GetProcessesByName("EXCEL").Length>0)
        throw new IOException("请先保存并关闭 Excel 和 TEK STOCK，然后点“重试安装”。");
      var jobs=FindOldPackages(); // Validate every command before changing any files.
      string staging=Path.Combine(Path.GetTempPath(),"TEK-STOCK-clean-"+Guid.NewGuid().ToString("N"));
      var roots=Roots.Current(); var backups=new List<MoveRecord>(); bool seeded=false;
      try {
        progress("正在校验随包程序、库存 Excel 和图片…");
        using(var input=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
          if(input==null) throw new IOException("安装包不完整，请重新下载。");
          var manifest=CleanCore.ExtractVerified(input,staging);
          var seedData=CleanCore.Json(Path.Combine(staging,"seed","snapshot.json"));
          if(!File.Exists(Path.Combine(staging,"app","TEK-STOCK-1.6.8-x64.exe")) || !File.Exists(Path.Combine(staging,"seed","workbook.xlsx"))
            || Convert.ToInt64(seedData["revision"])!=Convert.ToInt64(manifest["revision"])
            || ((System.Collections.ArrayList)seedData["items"]).Count!=Convert.ToInt32(manifest["itemCount"])) throw new IOException("随包库存不完整，未改动旧资料。");
        }
        progress("正在备份并移出本机旧测试库存…");
        backups=CleanCore.Archive(roots);
        var lines=new List<string>();foreach(var backup in backups) lines.Add(backup.Backup);
        backupNotice(String.Join(Environment.NewLine,lines.ToArray()));
        foreach(var job in jobs) { progress("正在卸载旧程序："+job.Key+"…"); Run(job.File,job.Arguments); }
        progress("正在安装 TEK STOCK 1.6.8…请允许 Windows 安装提示。");
        string destination=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"TEK STOCK");
        Run(Path.Combine(staging,"app","TEK-STOCK-1.6.8-x64.exe"),"/S /D="+destination);
        string executable=Path.Combine(destination,"TEK STOCK.exe");
        if(!File.Exists(executable) || !FileVersionInfo.GetVersionInfo(executable).ProductVersion.StartsWith("1.6.8")) throw new IOException("新程序版本未能确认；未导入测试库存。");
        progress("正在导入随包库存和图片…");
        CleanCore.ApplySeed(roots,Path.Combine(staging,"seed"),backups);seeded=true;
        return executable;
      } catch(PendingInstallException) { throw; }
      catch { if(!seeded) CleanCore.Restore(backups); throw; }
      finally { try { if((activeInstaller==null || activeInstaller.HasExited) && Directory.Exists(staging)) Directory.Delete(staging,true); } catch {} }
    }
  }
  public class SetupWindow : Form {
    readonly Label status=new Label(); readonly Button install=new Button(), close=new Button(), open=new Button();
    bool busy; string appPath="", backups="";
    public SetupWindow() {
      Text="TEK STOCK · 新加坡测试版全新安装";ClientSize=new Size(650,340);StartPosition=FormStartPosition.CenterScreen;
      Font=new Font("Microsoft YaHei UI",10);MaximizeBox=false;FormBorderStyle=FormBorderStyle.FixedDialog;
      var description=new Label {Left=25,Top=24,Width=600,Height=115,Text="自带当前测试库存、Excel 和现有产品图片。\n\n安装会卸载旧 TEK STOCK、移出旧测试资料，再导入随包库存。\n旧资料会保留备份；本机已有连接授权继续保留。\n请先保存并关闭 Excel 和 TEK STOCK。"};Controls.Add(description);
      status.SetBounds(25,150,600,85);status.Text="准备就绪。此包用于全新测试安装，日常升级请使用 APP 的 Update。";Controls.Add(status);
      install.Text="开始全新安装";install.SetBounds(25,260,170,42);install.Click+=async (s,e)=>await StartInstall();Controls.Add(install);
      open.Text="打开备份位置";open.SetBounds(215,260,170,42);open.Enabled=false;open.Click+=(s,e)=>OpenBackup();Controls.Add(open);
      close.Text="关闭";close.SetBounds(405,260,170,42);close.Click+=(s,e)=>Close();Controls.Add(close);
      FormClosing+=(s,e)=>{ if(busy) {e.Cancel=true;status.Text="Windows 安装正在进行，请等待这一步结束。";} };
    }
    void UpdateStatus(string text) { BeginInvoke((Action)(()=>status.Text=text)); }
    void OpenBackup() { if(backups.Length>0) {string first=backups.Split(new[]{Environment.NewLine},StringSplitOptions.RemoveEmptyEntries)[0];if(!Directory.Exists(first)) first=Path.GetDirectoryName(first);Process.Start("explorer.exe",CleanCoreQuote(first));} }
    static string CleanCoreQuote(string value) {return "\""+value.Replace("\"","")+"\"";}
    async Task StartInstall() {
      if(appPath.Length>0) {Process.Start(appPath);Close();return;}
      busy=true;install.Enabled=false;close.Enabled=false;
      try {
        appPath=await Task.Run(()=>Installer.Install(UpdateStatus,value=>backups=value));
        status.Text="安装完成：随包测试库存已导入。打开 APP 后核对库存和同步状态。";install.Text="打开 TEK STOCK";
      } catch(Exception error) {status.Text=error.Message;install.Text="重试安装";}
      finally {busy=false;install.Enabled=true;close.Enabled=true;open.Enabled=backups.Length>0;}
    }
    [STAThread] public static void Main() {CleanCore.Initialize();Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new SetupWindow());}
  }
}
