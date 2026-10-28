param()
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Net.Http
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
function JsonRequest($client,$method,$url,$body=$null){
 $req=[System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($method),$url)
 if($null -ne $body){$req.Content=[System.Net.Http.StringContent]::new(($body|ConvertTo-Json -Depth 30 -Compress),[Text.Encoding]::UTF8,'application/json')}
 $res=$client.SendAsync($req).GetAwaiter().GetResult()
 $value=$res.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json
 if(!$res.IsSuccessStatusCode){throw "HTTP_$([int]$res.StatusCode)_$method"}
 return $value
}
# Installers are hosted on Alibaba (design.myzolano.vip/tekstock): upload, download back and compare,
# then publish the Alibaba update feed that 1.6.17 and later read first.
$upload=& node (Join-Path $PSScriptRoot 'upload-installer-alibaba.cjs') $file --publish $version|Out-String
if($LASTEXITCODE -ne 0){Write-Output $upload;throw 'ALIBABA_UPLOAD_FAILED'}
$uploaded=$upload|ConvertFrom-Json
if(!$uploaded.published -or $uploaded.sha256 -ne $hash -or $uploaded.size -ne $size){throw 'ALIBABA_UPLOAD_NOT_VERIFIED'}
$origin=$uploaded.url
Write-Output "PUBLIC_ASSET_VERIFIED $version $size $hash"
$public=[System.Net.Http.HttpClient]::new()
$public.Timeout=[TimeSpan]::FromMinutes(1)
# Let Wrangler renew its existing OAuth session before reading the access token.
$wrangler=Get-ChildItem (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx\*\node_modules\wrangler\bin\wrangler.js') -File -ErrorAction SilentlyContinue|Select-Object -First 1
# Its warnings go to stderr, which Windows PowerShell 5.1 would treat as a failure under 'Stop'.
if($wrangler){$ErrorActionPreference='Continue';& node $wrangler.FullName whoami *> $null;$ErrorActionPreference='Stop';if($LASTEXITCODE -ne 0){throw 'RELEASE_AUTH_REFRESH_FAILED'}}
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
$req=[System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new('PATCH'),"$cfBase/settings")
$req.Content=$multipart
$r=$cf.SendAsync($req).GetAwaiter().GetResult()
$j=$r.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json
if(!$r.IsSuccessStatusCode -or !$j.success){Write-Output ($j.errors|ConvertTo-Json -Depth 4);throw "MANIFEST_PROMOTION_HTTP_$([int]$r.StatusCode)"}
# Every feed must now offer this version: Cloudflare for 1.6.16 and before, Alibaba for 1.6.17 and later.
foreach($url in @('https://tek-stock-maintenance.teopoh72.workers.dev/releases/latest.json','https://tek-stock-inventory-sg.teopoh72.workers.dev/releases/latest.json','https://tek-stock-sg-dsfbnvrbwu.ap-southeast-1.fcapp.run/releases/latest.json')){
 $matched=$false
 for($attempt=0;$attempt -lt 8;$attempt++){
  # Cloudflare takes a few seconds to roll the new settings out everywhere.
  if($attempt){Start-Sleep -Seconds 5}
  $live=JsonRequest $public GET $url
  if($live.desktop.version -eq $version -and $live.desktop.windows10.sha256 -eq $hash -and $live.desktop.windows10.url -eq $origin){$matched=$true;break}
 }
 if(!$matched){throw "LIVE_MANIFEST_NOT_UPDATED"}
 Write-Output "LIVE_MANIFEST_VERIFIED $url $version"
}
$receipt=@{version=$version;size=$size;sha256=$hash;sourceCommit=$commit;downloadUrl=$manifest.desktop.windows10.url;verifiedAt=[DateTime]::UtcNow.ToString('o')}
$receipt|ConvertTo-Json|Set-Content -Encoding utf8 (Join-Path $root "outputs\release-$version-receipt.json")
Copy-Item $file (Join-Path ([Environment]::GetFolderPath('Desktop')) $name)
Write-Output ($receipt|ConvertTo-Json)
