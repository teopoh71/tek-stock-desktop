"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  readAlibabaCloudConfigFiles,
  validateAlibabaCloudConfig,
} = require("../alibaba-config.cjs");

const actualConfig = {
  apiBaseUrl: "https://stock-api.aliyuncs.com",
  apiFallbackBaseUrls: ["https://stock-api-sg.aliyuncs.com"],
  authorityId: "tek-stock-hangzhou-v1",
  ossPublicBaseUrl: "https://tek-stock-photos.oss-cn-hangzhou.aliyuncs.com",
};

test("Alibaba config accepts only credential-free non-placeholder HTTPS endpoints", () => {
  assert.deepEqual(validateAlibabaCloudConfig(actualConfig), actualConfig);
  assert.throws(() => validateAlibabaCloudConfig({
    ...actualConfig, uploadToken: "secret",
  }), /unexpected field.*uploadToken/);
  assert.throws(() => validateAlibabaCloudConfig({
    ...actualConfig, apiBaseUrl: "https://inventory-api.example.com",
  }), /placeholder/);
  assert.throws(() => validateAlibabaCloudConfig({
    ...actualConfig, apiBaseUrl: "https://user:secret@stock-api.aliyuncs.com",
  }), /credential-free/);
  assert.throws(() => validateAlibabaCloudConfig({
    ...actualConfig, authorityId: "",
  }), /authorityId is required/);
  assert.throws(() => validateAlibabaCloudConfig({
    ...actualConfig, apiFallbackBaseUrls: "https://stock-api-sg.aliyuncs.com",
  }), /must be an array/);
});

test("desktop reads the packaged Alibaba config and skips an unsafe user override file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-alibaba-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packagedConfigPath = path.join(directory, "packaged-alibaba-cloud.json");
  fs.writeFileSync(path.join(directory, "alibaba-cloud.json"), JSON.stringify({
    ...actualConfig, uploadToken: "unsafe-extra-field",
  }));
  fs.writeFileSync(packagedConfigPath, JSON.stringify(actualConfig));
  assert.deepEqual(readAlibabaCloudConfigFiles({
    userDataPath: directory, packagedConfigPath, env: {},
  }), actualConfig);
});

test("packaged endpoints recover from stale user and environment overrides non-destructively", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-alibaba-config-recovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const userConfigPath = path.join(directory, "alibaba-cloud.json");
  const packagedConfigPath = path.join(directory, "packaged-alibaba-cloud.json");
  const userConfig = {
    apiBaseUrl: "https://retired-user-api.aliyuncs.com",
    ossPublicBaseUrl: "https://user-photos.oss-cn-hangzhou.aliyuncs.com",
  };
  const env = {
    TEK_STOCK_API_BASE_URL: "https://retired-env-api.aliyuncs.com",
    TEK_STOCK_OSS_PUBLIC_BASE_URL: "https://env-photos.oss-cn-hangzhou.aliyuncs.com",
  };
  fs.writeFileSync(userConfigPath, JSON.stringify(userConfig));
  fs.writeFileSync(packagedConfigPath, JSON.stringify(actualConfig));
  const originalUserConfig = fs.readFileSync(userConfigPath, "utf8");

  assert.deepEqual(readAlibabaCloudConfigFiles({
    userDataPath: directory, packagedConfigPath, env,
  }), actualConfig);
  assert.equal(fs.readFileSync(userConfigPath, "utf8"), originalUserConfig);
});

test("endpoint overrides remain available when no valid packaged config exists", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-alibaba-config-fallback-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const userConfig = {
    apiBaseUrl: "https://user-api.aliyuncs.com",
    ossPublicBaseUrl: "https://user-photos.oss-cn-hangzhou.aliyuncs.com",
  };
  fs.writeFileSync(path.join(directory, "alibaba-cloud.json"), JSON.stringify(userConfig));

  assert.deepEqual(readAlibabaCloudConfigFiles({
    userDataPath: directory,
    packagedConfigPath: path.join(directory, "missing-packaged-config.json"),
    env: { TEK_STOCK_API_BASE_URL: "https://env-api.aliyuncs.com" },
  }), {
    apiBaseUrl: "https://env-api.aliyuncs.com",
    apiFallbackBaseUrls: [],
    authorityId: "",
    ossPublicBaseUrl: userConfig.ossPublicBaseUrl,
  });
});

test("packaged primary keeps trusted support fallbacks for the same authority", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-alibaba-support-fallback-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packagedConfigPath = path.join(directory, "packaged-alibaba-cloud.json");
  fs.writeFileSync(packagedConfigPath, JSON.stringify({
    ...actualConfig,
    apiFallbackBaseUrls: [],
  }));
  fs.writeFileSync(path.join(directory, "alibaba-cloud.json"), JSON.stringify({
    apiBaseUrl: "https://ignored-user-primary.aliyuncs.com",
    apiFallbackBaseUrls: ["https://support-fallback.aliyuncs.com"],
    authorityId: actualConfig.authorityId,
    ossPublicBaseUrl: "https://ignored-user-photos.oss-cn-hangzhou.aliyuncs.com",
  }));

  const result = readAlibabaCloudConfigFiles({
    userDataPath: directory, packagedConfigPath, env: {},
  });
  assert.equal(result.apiBaseUrl, actualConfig.apiBaseUrl);
  assert.equal(result.authorityId, actualConfig.authorityId);
  assert.deepEqual(result.apiFallbackBaseUrls, ["https://support-fallback.aliyuncs.com"]);
});
