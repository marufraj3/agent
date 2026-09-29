import assert from 'node:assert/strict';
import test from 'node:test';
import { adminCookie, createAdminSession, parseCookies, verifyAdminSession } from '../auth/admin-session.js';

const secret='a-secure-admin-password-for-tests';
test('admin session is signed and tampering is rejected',()=>{const token=createAdminSession(secret,1);assert.equal(verifyAdminSession(token,secret),true);assert.equal(verifyAdminSession(`${token}x`,secret),false);assert.equal(token.includes(secret),false);});
test('admin cookie is HttpOnly, SameSite strict, bounded, and secure in production',()=>{const header=adminCookie('token',true,3600);assert.match(header,/HttpOnly/);assert.match(header,/SameSite=Strict/);assert.match(header,/Secure/);assert.match(header,/Max-Age=3600/);assert.equal(parseCookies('a=1; alzeena_admin_session=token').alzeena_admin_session,'token');});
