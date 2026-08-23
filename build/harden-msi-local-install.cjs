const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const packageJson = require(path.join(projectRoot, "package.json"));

function resolveMsiPath(input) {
  const candidate = input || path.join(
    projectRoot,
    "dist",
    `TEK-STOCK-Singapore-${packageJson.version}-x64.msi`,
  );
  const resolved = path.resolve(candidate);
  if (path.extname(resolved).toLowerCase() !== ".msi") {
    throw new Error(`Expected an MSI path: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`MSI does not exist: ${resolved}`);
  }
  return resolved;
}

function hardenMsiLocalInstall(msiPath) {
  const literal = `'${msiPath.replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$installer = New-Object -ComObject WindowsInstaller.Installer",
    `$database = $installer.GetType().InvokeMember('OpenDatabase','InvokeMethod',$null,$installer,@(${literal},1))`,
    "$read = $database.GetType().InvokeMember('OpenView','InvokeMethod',$null,$database,@(\"SELECT `Attributes` FROM `Feature` WHERE `Feature`='ProductFeature'\"))",
    "$read.GetType().InvokeMember('Execute','InvokeMethod',$null,$read,$null) | Out-Null",
    "$record = $read.GetType().InvokeMember('Fetch','InvokeMethod',$null,$read,$null)",
    "if ($null -eq $record) { throw 'ProductFeature is missing from MSI' }",
    "$attributes = $record.GetType().InvokeMember('IntegerData','GetProperty',$null,$record,@(1))",
    "$read.GetType().InvokeMember('Close','InvokeMethod',$null,$read,$null) | Out-Null",
    "$hardened = $attributes -bor 8",
    "$update = $database.GetType().InvokeMember('OpenView','InvokeMethod',$null,$database,@(\"UPDATE `Feature` SET `Attributes`=$hardened WHERE `Feature`='ProductFeature'\"))",
    "$update.GetType().InvokeMember('Execute','InvokeMethod',$null,$update,$null) | Out-Null",
    "$update.GetType().InvokeMember('Close','InvokeMethod',$null,$update,$null) | Out-Null",
    "$database.GetType().InvokeMember('Commit','InvokeMethod',$null,$database,$null) | Out-Null",
    "Write-Output $hardened",
  ].join("; ");

  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  }).trim();
  const attributes = Number(output);
  if (!Number.isInteger(attributes) || (attributes & 8) === 0) {
    throw new Error(`MSI ProductFeature was not hardened: ${output}`);
  }
  return attributes;
}

if (require.main === module) {
  const msiPath = resolveMsiPath(process.argv[2]);
  const attributes = hardenMsiLocalInstall(msiPath);
  process.stdout.write(`Hardened ProductFeature for local install: attributes=${attributes}\n`);
}

module.exports = { hardenMsiLocalInstall, resolveMsiPath };
