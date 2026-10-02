param()
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$package=Get-Content -Raw (Join-Path $root 'package.json')|ConvertFrom-Json
$version=$package.version
$smoke=Get-Content -Raw (Join-Path $root 'outputs\task-6-packaged-electron-smoke.json')|ConvertFrom-Json
if(!$smoke.ok -or $smoke.packageVersion -ne $version){throw 'PACKAGED_SMOKE_NOT_VERIFIED'}
$tests=Get-Content -Raw (Join-Path $root 'verification-tests.log')
if($tests -notmatch '# fail 0'){throw 'TESTS_NOT_VERIFIED'}
$name="TEK-STOCK-Singapore-$version-x64.exe"
$file=Join-Path $root "dist-update\$name"
$hash=(Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant()
$size=(Get-Item $file).Length
$commit=(& git -C $root rev-parse HEAD).Trim()
$tag="v$version-auto-update"
$env:GIT_TERMINAL_PROMPT='0'
$raw="protocol=https`nhost=github.com`n`n"|git credential fill
$token=($raw|Where-Object {$_ -like 'password=*'}).Substring(9)
$gh=[System.Net.Http.HttpClient]::new()
$gh.Timeout=[TimeSpan]::FromMinutes(6)
$gh.DefaultRequestHeaders.Authorization=[System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$token)
$gh.DefaultRequestHeaders.UserAgent.ParseAdd('TEK-STOCK-release')
function JsonRequest($client,$method,$url,$body=$null){
 $req=[System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($method),$url)
 if($null -ne $body){$req.Content=[System.Net.Http.StringContent]::new(($body|ConvertTo-Json -Depth 30 -Compress),[Text.Encoding]::UTF8,'application/json')}
 $res=$client.SendAsync($req).GetAwaiter().GetResult()
 $value=$res.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json
 if(!$res.IsSuccessStatusCode){throw "HTTP_$([int]$res.StatusCode)_$method"}
 return $value
}
$base='https://api.github.com/repos/teopoh71/tek-stock-desktop'
$res=$gh.GetAsync("$base/releases/tags/$tag").GetAwaiter().GetResult()
if([int]$res.StatusCode -eq 404){
 $release=JsonRequest $gh POST "$base/releases" @{tag_name=$tag;target_commitish=$commit;name="TEK STOCK $version";draft=$true;prerelease=$false;body="Windows 10/11 x64. Follows validated HTTPS download redirects synchronously in Electron. Checks verified software updates even after Excel sync fails; keeps the sync failure visible. Preserves existing workbook, credentials, outbox and photo cache. Packaged isolated sync and upgrade checks passed. The reported Singapore UNKNOWN_ERROR remains under investigation."}
}else{
 if(!$res.IsSuccessStatusCode){throw 'RELEASE_ACCESS_FAILED'}
 $release=$res.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json
}
$asset=@($release.assets|Where-Object name -eq $name)
if(!$asset.Count){
 $url=$release.upload_url.Split('{')[0]+'?name='+[Uri]::EscapeDataString($name)
 $stream=[IO.File]::OpenRead($file)
 try{
  $content=[System.Net.Http.StreamContent]::new($stream)
  $content.Headers.ContentType=[System.Net.Http.Headers.MediaTypeHeaderValue]::new('application/octet-stream')
  $r=$gh.PostAsync($url,$content).GetAwaiter().GetResult()
  if(!$r.IsSuccessStatusCode){throw "ASSET_UPLOAD_HTTP_$([int]$r.StatusCode)"}
  $asset=@($r.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json)
 }finally{$stream.Dispose()}
}
if($asset[0].size -ne $size){throw 'UPLOADED_SIZE_MISMATCH'}
if($asset[0].digest -and $asset[0].digest -ne "sha256:$hash"){throw 'UPLOADED_HASH_MISMATCH'}
$release=JsonRequest $gh PATCH "$base/releases/$($release.id)" @{draft=$false}
$origin=$asset[0].browser_download_url
$public=[System.Net.Http.HttpClient]::new()
$public.Timeout=[TimeSpan]::FromMinutes(6)
$download=Join-Path $root "outputs\verified-$name"
if(!(Test-Path $download) -or (Get-Item $download).Length -ne $size -or (Get-FileHash -Algorithm SHA256 $download).Hash.ToLowerInvariant() -ne $hash){
 $r=$public.GetAsync($origin).GetAwaiter().GetResult()
 if(!$r.IsSuccessStatusCode){throw "PUBLIC_ASSET_HTTP_$([int]$r.StatusCode)"}
 $bytes=$r.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
 [IO.File]::WriteAllBytes($download,$bytes)
}
if((Get-Item $download).Length -ne $size -or (Get-FileHash -Algorithm SHA256 $download).Hash.ToLowerInvariant() -ne $hash){throw 'PUBLIC_ASSET_VERIFICATION_FAILED'}
Write-Output "PUBLIC_ASSET_VERIFIED $version $size $hash"
$c=Get-Content -Raw "$env:APPDATA\xdg.config\.wrangler\config\default.toml"
$cfToken=[regex]::Match($c,'(?m)^oauth_token\s*=\s*"([^"\r\n]+)"').Groups[1].Value
$cf=[System.Net.Http.HttpClient]::new()
$cf.DefaultRequestHeaders.Authorization=[System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$cfToken)
$cfBase='https://api.cloudflare.com/client/v4/accounts/45f3999f61cb69fb6932f8105157cb60/workers/scripts/tek-stock-maintenance'
$before=JsonRequest $cf GET "$cfBase/settings"
$versions=JsonRequest $cf GET "$cfBase/versions"
$prior=$versions.result.items[0].id
$manifest=@{desktop=@{version=$version;windows10=@{url=$origin;sha256=$hash;size=$size}}}
$changed=@{RELEASE_ASSET_URL=$origin;RELEASE_MANIFEST=($manifest|ConvertTo-Json -Depth 8 -Compress)}
$rollback=@{bindings=@($before.result.bindings|ForEach-Object {if($_.name -in @('RELEASE_ASSET_URL','RELEASE_MANIFEST')){$_}else{@{name=$_.name;type='inherit';version_id='latest'}}})}
$rollback|ConvertTo-Json -Depth 12|Set-Content -Encoding utf8 (Join-Path $root "outputs\release-$version-rollback.json")
$bindings=@($before.result.bindings|ForEach-Object {if($changed.ContainsKey($_.name)){@{name=$_.name;type='plain_text';text=$changed[$_.name]}}else{@{name=$_.name;type='inherit';version_id='latest'}}})
if(@($bindings|Where-Object {$_.name -in @('RELEASE_ASSET_URL','RELEASE_MANIFEST')}).Count -ne 2){throw 'RELEASE_BINDINGS_MISSING'}
$body=@{bindings=$bindings;annotations=@{'workers/message'="Verified TEK STOCK $version release"}}
$multipart=[System.Net.Http.MultipartFormDataContent]::new()
$part=[System.Net.Http.StringContent]::new(($body|ConvertTo-Json -Depth 15 -Compress),[Text.Encoding]::UTF8,'application/json')
$multipart.Add($part,'settings')
$req=[System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Patch,"$cfBase/settings")
$req.Content=$multipart
$r=$cf.SendAsync($req).GetAwaiter().GetResult()
$j=$r.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json
if(!$r.IsSuccessStatusCode -or !$j.success){Write-Output ($j.errors|ConvertTo-Json -Depth 4);throw "MANIFEST_PROMOTION_HTTP_$([int]$r.StatusCode)"}
foreach($url in @('https://tek-stock-maintenance.teopoh72.workers.dev/releases/latest.json','https://tek-stock-inventory-sg.teopoh72.workers.dev/releases/latest.json')){
 $matched=$false
 for($attempt=0;$attempt -lt 4;$attempt++){
  $live=JsonRequest $public GET $url
  if($live.desktop.version -eq $version -and $live.desktop.windows10.sha256 -eq $hash -and $live.desktop.windows10.url -eq $origin){$matched=$true;break}
 }
 if(!$matched){throw "LIVE_MANIFEST_NOT_UPDATED"}
 Write-Output "LIVE_MANIFEST_VERIFIED $url $version"
}
$receipt=@{version=$version;size=$size;sha256=$hash;sourceCommit=$commit;releaseUrl=$release.html_url;downloadUrl=$manifest.desktop.windows10.url;verifiedAt=[DateTime]::UtcNow.ToString('o')}
$receipt|ConvertTo-Json|Set-Content -Encoding utf8 (Join-Path $root "outputs\release-$version-receipt.json")
Copy-Item $file (Join-Path ([Environment]::GetFolderPath('Desktop')) $name)
Write-Output ($receipt|ConvertTo-Json)
