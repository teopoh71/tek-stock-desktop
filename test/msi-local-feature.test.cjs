const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const msiPath = path.join(root, "dist", `TEK-STOCK-Singapore-${packageJson.version}-x64.msi`);

function readProductFeatureAttributes(msi) {
  const msiLiteral = `'${msi.replaceAll("'", "''")}'`;
  const script = [
    "$installer = New-Object -ComObject WindowsInstaller.Installer",
    `$database = $installer.GetType().InvokeMember('OpenDatabase','InvokeMethod',$null,$installer,@(${msiLiteral},0))`,
    "$view = $database.GetType().InvokeMember('OpenView','InvokeMethod',$null,$installer,@(\"SELECT `Attributes` FROM `Feature` WHERE `Feature`='ProductFeature'\"))",
    "$view.GetType().InvokeMember('Execute','InvokeMethod',$null,$view,$null) | Out-Null",
    "$record = $view.GetType().InvokeMember('Fetch','InvokeMethod',$null,$view,$null)",
    "$record.GetType().InvokeMember('IntegerData','GetProperty',$null,$record,@(1))",
  ].join("; ");

  return Number(execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  }).trim());
}

test("MSI ProductFeature cannot be installed as advertised", (t) => {
  if (!fs.existsSync(msiPath)) {
    t.skip("MSI artifact inspection runs when dist:msi has produced the package");
    return;
  }
  const attributes = readProductFeatureAttributes(msiPath);
  assert.notEqual(attributes & 8, 0, `ProductFeature attributes ${attributes} allow advertised install`);
});

test("MSI build command hardens ProductFeature after packaging", () => {
  assert.match(packageJson.scripts["dist:msi"], /harden-msi-local-install\.cjs/);
});
