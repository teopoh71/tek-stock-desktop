using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Web.Script.Serialization;

namespace TekClean {
  public class CleanTests {
    static int checks;
    static void Check(bool value,string label) {if(!value) throw new Exception(label);checks++;}
    static Roots MakeRoots(string root) {
      var r=new Roots {Roaming=Path.Combine(root,"Roaming"),Local=Path.Combine(root,"Local"),Documents=Path.Combine(root,"Documents")};
      Directory.CreateDirectory(r.Roaming);Directory.CreateDirectory(r.Local);Directory.CreateDirectory(r.Documents);return r;
    }
    static void Write(string file,string text) {Directory.CreateDirectory(Path.GetDirectoryName(file));File.WriteAllText(file,text,CleanCore.Utf8);}
    static void OldData(Roots r) {
      Write(Path.Combine(r.Profile,"old-inventory.txt"),"old-test-data");
      Write(Path.Combine(r.Profile,"central-sync","outbox.json"),"old-pending-work");
      Write(Path.Combine(r.Profile,"sync-credentials.json"),"encrypted-local-credential");
      Write(Path.Combine(r.Workbooks,"old-client","TEK-STOCK-LIVE.xlsx"),"old-workbook");
      Write(Path.Combine(r.Documents,"TEK STOCK","TEK-STOCK-LIVE.xlsx"),"legacy-workbook");
      Write(Path.Combine(r.Documents,"unrelated.txt"),"must-remain");
    }
    static void MakeSeed(string seed) {
      Write(Path.Combine(seed,"workbook.xlsx"),"seed-workbook-bytes");
      Write(Path.Combine(seed,"snapshot.json"),"{\"revision\":149,\"items\":[{\"id\":\"test-1\"}]}");
      Write(Path.Combine(seed,"photos","abc","photo.webp"),"seed-photo-bytes");
    }
    static MemoryStream ZipPayload(string pathOverride,bool wrongHash) {
      var stream=new MemoryStream();
      var files=new Dictionary<string,object>();
      using(var zip=new ZipArchive(stream,ZipArchiveMode.Create,true)) {
        foreach(var name in new[]{pathOverride,"seed/workbook.xlsx","seed/snapshot.json"}) {
          var bytes=Encoding.UTF8.GetBytes("test-payload");
          using(var output=zip.CreateEntry(name).Open()) output.Write(bytes,0,bytes.Length);
          string hash;using(var digest=System.Security.Cryptography.SHA256.Create())hash=BitConverter.ToString(digest.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
          files[name]=new {size=bytes.Length,sha256=wrongHash?new string('0',64):hash};
        }
        var body=Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new {schema=1,files=files}));
        using(var output=zip.CreateEntry("bundle.json").Open())output.Write(body,0,body.Length);
      }
      stream.Position=0;return stream;
    }
    public static int Main(string[] args) {
      CleanCore.Initialize();
      if(args.Length==1 && args[0]=="--plan") {
        var jobs=Installer.FindOldPackages();
        Console.WriteLine(new JavaScriptSerializer().Serialize(new {ok=true,msi=jobs.FindAll(j=>Path.GetFileName(j.File)=="msiexec.exe").Count,nsis=jobs.FindAll(j=>j.Arguments.StartsWith("/S _?=")).Count}));
        return 0;
      }
      string root=Path.Combine(Path.GetTempPath(),"TEK-STOCK-clean-tests-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
      try {
        var a=MakeRoots(Path.Combine(root,"A"));OldData(a);string seed=Path.Combine(root,"seed");MakeSeed(seed);
        var backups=CleanCore.Archive(a);
        Check(backups.Count==3,"archive exact existing targets");Check(!Directory.Exists(a.Profile),"old active profile removed");
        string workbook=CleanCore.ApplySeed(a,seed,backups);
        Check(File.ReadAllText(workbook)=="seed-workbook-bytes","seed workbook exact");
        Check(!File.Exists(Path.Combine(a.Profile,"central-sync","outbox.json")),"old pending queue not reused");
        Check(!File.Exists(Path.Combine(a.Profile,"old-inventory.txt")),"old inventory not active");
        Check(File.ReadAllText(Path.Combine(a.Profile,"sync-credentials.json"))=="encrypted-local-credential","same-user credential retained");
        Check(File.Exists(Path.Combine(a.Profile,"central-sync","photo-cache","abc","photo.webp")),"photos imported");
        Check(File.ReadAllText(Path.Combine(a.Documents,"unrelated.txt"))=="must-remain","unrelated data preserved");
        Check(File.ReadAllText(Path.Combine(backups[0].Backup,"old-inventory.txt"))=="old-test-data","old data recoverable");
        var b=MakeRoots(Path.Combine(root,"B"));OldData(b);var archivedB=CleanCore.Archive(b);CleanCore.Restore(archivedB);
        Check(File.ReadAllText(Path.Combine(b.Profile,"old-inventory.txt"))=="old-test-data","rollback restores original");
        bool refused=false;try{CleanCore.ApplySeed(b,seed,new List<MoveRecord>());}catch(IOException){refused=true;}
        Check(refused,"refuse overwrite of active profile");
        using(var zip=ZipPayload("app/installer.exe",false))CleanCore.ExtractVerified(zip,Path.Combine(root,"valid"));checks++;
        refused=false;try{using(var zip=ZipPayload("../escape.exe",false))CleanCore.ExtractVerified(zip,Path.Combine(root,"traversal"));}catch(IOException){refused=true;}
        Check(refused && !File.Exists(Path.Combine(root,"escape.exe")),"reject zip path escape");
        refused=false;try{using(var zip=ZipPayload("app/installer.exe",true))CleanCore.ExtractVerified(zip,Path.Combine(root,"corrupt"));}catch(IOException){refused=true;}
        Check(refused,"reject corrupt payload before cleanup");
        if(args.Length==2 && (args[0]=="--payload" || args[0]=="--bundle")) {
          string extracted=Path.Combine(root,"real");Dictionary<string,object> manifest;
          using(var stream=args[0]=="--bundle" ? System.Reflection.Assembly.LoadFile(Path.GetFullPath(args[1])).GetManifestResourceStream("payload.zip") : File.OpenRead(args[1]))manifest=CleanCore.ExtractVerified(stream,extracted);
          var actual=MakeRoots(Path.Combine(root,"actual"));OldData(actual);
          string actualWorkbook=CleanCore.ApplySeed(actual,Path.Combine(extracted,"seed"),CleanCore.Archive(actual));
          Check(CleanCore.Hash(actualWorkbook)==CleanCore.Hash(Path.Combine(extracted,"seed","workbook.xlsx")),"actual workbook imported byte-for-byte");
          Console.WriteLine(new JavaScriptSerializer().Serialize(new {ok=true,checks=checks,root=root,profile=actual.Profile,workbook=actualWorkbook,revision=manifest["revision"],itemCount=manifest["itemCount"]}));
        } else Console.WriteLine(new JavaScriptSerializer().Serialize(new {ok=true,checks=checks}));
        return 0;
      } catch(Exception e) {Console.Error.WriteLine(e.ToString());return 1;}
      // A payload test keeps its isolated output for the native workbook reader.
      finally {if(args.Length==0)Directory.Delete(root,true);}
    }
  }
}
