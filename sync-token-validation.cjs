"use strict";

function tokenError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateSyncToken(value) {
  const raw = String(value || "");
  if (/[^\t\x20-\x7e\x80-\xff]/.test(raw)) throw tokenError("SYNC_TOKEN_INVALID");
  const token = raw.trim();
  if (!token) throw tokenError("SYNC_TOKEN_MISSING");
  return token;
}

module.exports = { validateSyncToken };
