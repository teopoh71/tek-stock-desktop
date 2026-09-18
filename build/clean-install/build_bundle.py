"""Build a private, self-contained Singapore test installer. Never run the installer here."""
from pathlib import Path
import os,json,hashlib,shutil,subprocess,zipfile,urllib.request,datetime

repo=Path(__file__).resolve().parents[2]
output=Path(os.environ.get('TEK_CLEAN_OUTPUT',str(repo.parent/'clean-bundle-20260918')))
output.mkdir(parents=True,exist_ok=True)
stage=output/'payload'
stage.mkdir(exist_ok=True)
profile=Path(os.environ['APPDATA'])/'samlee-inventory-desktop'
snapshot_path=profile/'central-sync'/'last-good-snapshot.json'
snapshot_bytes=snapshot_path.read_bytes()
snapshot=json.loads(snapshot_bytes)
client=json.loads((profile/'workbook-client.json').read_text(encoding='utf-8-sig'))['clientId']
workbook=Path(os.environ['LOCALAPPDATA'])/'TEK STOCK'/'workbooks'/client/'TEK-STOCK-LIVE.xlsx'
workbook_bytes=workbook.read_bytes()
def digest(data):return hashlib.sha256(data).hexdigest()
node=Path.home()/'AppData/Local/hermes/node/node.exe'
env=dict(os.environ,TEK_STOCK_TEST='1')
js="const fs=require('fs');const m=require('./main.cjs');m.readWorkbookFile(process.argv[1]).then(w=>{if(!w.ok||w.hasUnacknowledgedChanges||!w.integrity.itemIdsDuplicateFree)throw Error('Source workbook is not clean');console.log(JSON.stringify({revision:w.sync.revision,ids:w.items.map(x=>x.id),sha256:w.sha256}));}).catch(e=>{console.error(e.message);process.exit(1)})"
result=subprocess.run([str(node),'-e',js,str(workbook)],cwd=repo,env=env,capture_output=True,text=True,encoding='utf-8',timeout=60,check=True)
native=json.loads(result.stdout)
assert native['sha256']==digest(workbook_bytes) and native['revision']==snapshot['revision']
assert set(native['ids'])==set(i['id'] for i in snapshot['items'])
outbox=profile/'central-sync'/'outbox.json'
if outbox.exists():
 assert not json.loads(outbox.read_text(encoding='utf-8-sig')).get('entries',[]),'Pending source operations'
seed=stage/'seed';seed.mkdir(exist_ok=True)
(seed/'workbook.xlsx').write_bytes(workbook_bytes)
(seed/'snapshot.json').write_bytes(snapshot_bytes)
selected={'seed/workbook.xlsx','seed/snapshot.json'}
photos=0
for item in snapshot['items']:
 if not item.get('image'):continue
 sha=str(item.get('imageSha256','')).lower()
 assert len(sha)==64 and all(c in '0123456789abcdef' for c in sha),'Unverified source photo'
 product=hashlib.sha256(item['id'].encode()).hexdigest()[:32]
 source=None
 for ext in ['webp','jpg','png']:
  candidate=profile/'central-sync'/'photo-cache'/product/(sha+'.'+ext)
  if candidate.is_file() and digest(candidate.read_bytes())==sha:source=candidate;break
 if source is None:
  raise RuntimeError('A source photo is not fully cached; stop before packaging')
 rel='seed/photos/'+product+'/'+source.name
 target=stage/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
 selected.add(rel);photos+=1
installer=repo/'dist-update'/'TEK-STOCK-新加坡库存-1.6.8-x64.exe'
assert digest(installer.read_bytes())=='65347a5ee8144cb47d694a539ef1f249ba5a1ffa18244107e29ca7c1cf18d3ba'
inner=stage/'app'/'TEK-STOCK-1.6.8-x64.exe';inner.parent.mkdir(exist_ok=True);shutil.copy2(installer,inner)
selected.add('app/TEK-STOCK-1.6.8-x64.exe')
assert workbook.read_bytes()==workbook_bytes and snapshot_path.read_bytes()==snapshot_bytes,'Source changed while copying'
manifest={'schema':1,'version':'1.6.8','createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'revision':snapshot['revision'],'itemCount':len(snapshot['items']),'photoCount':photos,'files':{}}
for rel in sorted(selected):
 b=(stage/rel).read_bytes()
 manifest['files'][rel]={'sha256':digest(b),'size':len(b)}
payload=output/'payload.zip'
with zipfile.ZipFile(payload,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for rel in sorted(selected):z.write(stage/rel,rel)
 z.writestr('bundle.json',json.dumps(manifest,ensure_ascii=False,separators=(',',':')))
(output/'bundle-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
csc=Path(os.environ['WINDIR'])/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
references=['System.IO.Compression.dll','System.IO.Compression.FileSystem.dll','System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll']
exe=output/'TEK-STOCK-1.6.8-Clean-Inventory-x64.exe'
cmd=[str(csc),'/nologo','/codepage:65001','/target:winexe','/platform:x64','/optimize+','/win32manifest:'+str(repo/'build/clean-install/app.manifest'),'/win32icon:'+str(repo/'build/tek-stock-logo.ico'),'/out:'+str(exe),'/resource:'+str(payload)+',payload.zip']
cmd+=['/r:'+r for r in references]
cmd+=[str(repo/'build/clean-install/CleanCore.cs'),str(repo/'build/clean-install/Program.cs')]
subprocess.run(cmd,cwd=repo,check=True)
summary={'ok':True,'installer':str(exe),'bytes':exe.stat().st_size,'sha256':digest(exe.read_bytes()),'items':len(snapshot['items']),'photos':photos,'withoutPhoto':len(snapshot['items'])-photos,'revision':snapshot['revision'],'workbookSha256':digest(workbook_bytes),'payload':str(payload)}
(output/'build-summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps(summary))
