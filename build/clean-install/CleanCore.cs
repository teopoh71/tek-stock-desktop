using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]

namespace TekClean {
  public class Roots {
    public string Roaming, Local, Documents;
    public string Profile { get { return Path.Combine(Roaming, "samlee-inventory-desktop"); } }
    public string Workbooks { get { return Path.Combine(Local, "TEK STOCK", "workbooks"); } }
    public static Roots Current() {
      return new Roots { Roaming=Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        Local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        Documents=Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments) };
    }
  }
  public class MoveRecord { public string Original, Backup; }
  public class CleanCore {
    static CleanCore() {
      AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);
      AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
    }
    public static void Initialize() {}
    public static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    public static string Hash(string file) {
      using(var stream=File.OpenRead(file)) using(var hash=SHA256.Create())
        return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    public static Dictionary<string,object> Json(string file) {
      return new JavaScriptSerializer { MaxJsonLength=8000000 }.Deserialize<Dictionary<string,object>>(File.ReadAllText(file, Utf8));
    }
    public static void WriteJson(string file, object value) {
      Directory.CreateDirectory(Path.GetDirectoryName(file));
      File.WriteAllText(file, new JavaScriptSerializer { MaxJsonLength=8000000 }.Serialize(value), Utf8);
    }
    public static string Inside(string root, string relative) {
      if(String.IsNullOrWhiteSpace(relative) || relative.IndexOf(':')>=0 || relative.IndexOf('\\')>=0 || Path.IsPathRooted(relative))
        throw new IOException("安装资料路径无效。");
      foreach(var part in relative.Split('/')) if(part==".." || part=="." || part=="") throw new IOException("安装资料路径无效。");
      var full=Path.GetFullPath(Path.Combine(root,relative.Replace('/',Path.DirectorySeparatorChar)));
      if(!full.StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))
        throw new IOException("安装资料超出指定目录。");
      return full;
    }
    public static void CheckTree(string path) {
      if(!Directory.Exists(path) && !File.Exists(path)) return;
      if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0) throw new IOException("发现链接目录，已停止清理："+path);
      if(Directory.Exists(path)) foreach(var child in Directory.GetFileSystemEntries(path)) CheckTree(child);
    }
    public static Dictionary<string,object> ExtractVerified(Stream input, string destination) {
      Directory.CreateDirectory(destination);
      using(var zip=new ZipArchive(input,ZipArchiveMode.Read)) {
        var entry=zip.GetEntry("bundle.json");
        if(entry==null || entry.Length>2000000) throw new IOException("安装资料清单缺失。");
        string text;
        using(var reader=new StreamReader(entry.Open(),Utf8)) text=reader.ReadToEnd();
        var manifest=new JavaScriptSerializer { MaxJsonLength=2000000 }.Deserialize<Dictionary<string,object>>(text);
        if(Convert.ToInt32(manifest["schema"])!=1) throw new IOException("安装资料格式无效。");
        var files=(Dictionary<string,object>)manifest["files"];
        if(files.Count<3 || files.Count>3000 || zip.Entries.Count!=files.Count+1) throw new IOException("安装资料数量无效。");
        var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total=0;
        foreach(var file in files) {
          var target=Inside(destination,file.Key);
          if(!seen.Add(target)) throw new IOException("安装资料路径重复。");
          var descriptor=(Dictionary<string,object>)file.Value;
          var source=zip.GetEntry(file.Key);
          if(source==null || source.Length!=Convert.ToInt64(descriptor["size"]) || source.Length<1) throw new IOException("安装资料长度不符。");
          total+=source.Length;
          if(total>700000000) throw new IOException("安装资料过大。");
          Directory.CreateDirectory(Path.GetDirectoryName(target));
          using(var from=source.Open()) using(var to=new FileStream(target,FileMode.CreateNew)) from.CopyTo(to);
          if(Hash(target)!=(string)descriptor["sha256"]) throw new IOException("安装资料校验失败，请重新下载完整包。");
        }
        WriteJson(Path.Combine(destination,"bundle.json"),manifest);
        return manifest;
      }
    }
    public static List<string> Targets(Roots r) {
      if(String.IsNullOrEmpty(r.Roaming)||String.IsNullOrEmpty(r.Local)||String.IsNullOrEmpty(r.Documents)) throw new IOException("无法确定本机资料目录。");
      return new List<string> { r.Profile, Path.Combine(r.Roaming,"tek-stock-inventory"),
        r.Workbooks, Path.Combine(r.Documents,"TEK STOCK") };
    }
    public static List<MoveRecord> Archive(Roots roots) {
      var records=new List<MoveRecord>();
      foreach(var target in Targets(roots)) CheckTree(target);
      string stamp=DateTime.Now.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N").Substring(0,8);
      try {
        foreach(var target in Targets(roots)) {
          if(!Directory.Exists(target)) continue;
          var backup=target+".before-clean-"+stamp;
          Directory.Move(target,backup);
          records.Add(new MoveRecord { Original=target, Backup=backup });
        }
        return records;
      } catch { Restore(records); throw; }
    }
    public static void Restore(List<MoveRecord> records) {
      for(int i=records.Count-1;i>=0;i--) {
        var record=records[i];
        if(Directory.Exists(record.Backup) && !Directory.Exists(record.Original)) Directory.Move(record.Backup,record.Original);
      }
    }
    static string ExtendedPath(string file) {
      var full=Path.GetFullPath(file);
      if(full.StartsWith(@"\\?\")) return full;
      return full.StartsWith(@"\\") ? @"\\?\UNC\"+full.Substring(2) : @"\\?\"+full;
    }
    static void CopyFile(string from,string to) { File.Copy(ExtendedPath(from),ExtendedPath(to),false); }
    static void CopyTree(string from, string to) {
      CheckTree(from); Directory.CreateDirectory(to);
      foreach(var file in Directory.GetFiles(from)) CopyFile(file,Path.Combine(to,Path.GetFileName(file)));
      foreach(var folder in Directory.GetDirectories(from)) CopyTree(folder,Path.Combine(to,Path.GetFileName(folder)));
    }
    public static string ApplySeed(Roots roots, string seed, List<MoveRecord> backups) {
      if(Directory.Exists(roots.Profile)||Directory.Exists(roots.Workbooks)) throw new IOException("旧资料尚未移出，已停止导入。");
      string id=Guid.NewGuid().ToString(), profileStage=roots.Profile+".seed-"+id, workStage=roots.Workbooks+".seed-"+id;
      var workbook=Path.Combine(seed,"workbook.xlsx");
      var snapshot=Json(Path.Combine(seed,"snapshot.json"));
      if(Convert.ToInt64(snapshot["revision"])<0 || ((ArrayList)snapshot["items"]).Count==0) throw new IOException("随包库存无效。");
      try {
        Directory.CreateDirectory(profileStage);
        Directory.CreateDirectory(Path.Combine(workStage,id));
        CopyFile(workbook,Path.Combine(workStage,id,"TEK-STOCK-LIVE.xlsx"));
        if(Hash(workbook)!=Hash(Path.Combine(workStage,id,"TEK-STOCK-LIVE.xlsx"))) throw new IOException("库存 Excel 复制校验失败。");
        WriteJson(Path.Combine(profileStage,"workbook-client.json"),new {clientId=id});
        Directory.CreateDirectory(Path.Combine(profileStage,"central-sync"));
        CopyFile(Path.Combine(seed,"snapshot.json"),Path.Combine(profileStage,"central-sync","last-good-snapshot.json"));
        if(Directory.Exists(Path.Combine(seed,"photos"))) CopyTree(Path.Combine(seed,"photos"),Path.Combine(profileStage,"central-sync","photo-cache"));
        // Retain only this same Windows user's encrypted connection credential.
        foreach(var prior in backups) if(prior.Original==roots.Profile) {
          var credential=Path.Combine(prior.Backup,"sync-credentials.json");
          if(File.Exists(credential)) CopyFile(credential,Path.Combine(profileStage,"sync-credentials.json"));
        }
        WriteJson(Path.Combine(profileStage,"clean-install-receipt.json"),new {schema=1,version="1.6.8",at=DateTime.UtcNow.ToString("o"),seedRevision=snapshot["revision"],backups=backups});
        Directory.Move(workStage,roots.Workbooks);
        try { Directory.Move(profileStage,roots.Profile); }
        catch { Directory.Move(roots.Workbooks,workStage); throw; }
        return Path.Combine(roots.Workbooks,id,"TEK-STOCK-LIVE.xlsx");
      } catch {
        if(Directory.Exists(profileStage)) Directory.Delete(profileStage,true);
        if(Directory.Exists(workStage)) Directory.Delete(workStage,true);
        throw;
      }
    }
  }
}
