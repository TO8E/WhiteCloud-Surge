/*
 * whitecloud_unlock.js
 * 白云天气 2.81 (com.wuxin.WhiteCloud) · Surge 会员解锁
 *
 * 会员判定的真实链路（静态确认）：
 *   二进制里 "allaccess" 判定函数 -> RC CustomerInfo.entitlements["allaccess"].isActive
 *   RC 客户信息接口: GET  https://api.revenuecat.com/v1/subscribers/{app_user_id}
 *   收据校验      : POST https://api.revenuecat.com/v1/receipts
 *   自有后端      : https://untech.cc/api/v2/bootstrap、/api/v2/users/user-settings
 *
 * 本脚本做两件事：
 *   1) RC 客户信息整体替换为"已订阅"，时间线拉到 2100（覆盖 304 / If-None-Match）
 *   2) 自有后端响应里的会员布尔字段递归翻转
 *
 * 注意：若 App 开了 Trusted Entitlements（enforced 签名校验），RC 会拒收改动后的 body，
 *      报 SIGNATURE_VERIFICATION_FAILED —— 那种情况下网络层改不动，只能走 IPA 补丁。
 */

(function () {
  'use strict';

  var RC_HOST_RE = /(^|\.)(api\.revenuecat\.com|api\.rc-backup\.com)$/;
  var ENT_ID = 'allaccess';
  var PRODUCT = 'whitecloud.allaccess.yearly';
  var PURCHASE = '2026-01-01T00:00:00Z';
  var EXPIRES = '2100-01-01T00:00:00Z';

  /* ---------------------------------------------------------------- 工具 */

  function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function log(msg) {
    console.log('[WC-Unlock] ' + msg);
  }

  function parseBody(body) {
    if (!body) return null;
    try { return JSON.parse(body); } catch (e) { return null; }
  }

  /* ------------------------------------------------------- RevenueCat */

  function entitlementObject() {
    return {
      expires_date: EXPIRES,
      purchase_date: PURCHASE,
      product_identifier: PRODUCT,
      store: 'app_store',
      ownership_type: 'PURCHASED'
    };
  }

  function subscriptionObject() {
    return {
      billing_issues_detected_at: null,
      expires_date: EXPIRES,
      grace_period_expires_date: null,
      is_sandbox: false,
      original_purchase_date: PURCHASE,
      period_type: 'normal',
      purchase_date: PURCHASE,
      store: 'app_store',
      unsubscribe_detected_at: null,
      ownership_type: 'PURCHASED'
    };
  }

  function subscriberFor(appUserId) {
    var entitlements = {};
    // 主判定 + 常见别名都铺满，避免 App 内部换 key 名就掉会员
    var names = [ENT_ID, 'pro', 'premium', 'vip', 'member', 'membership',
                 'whitecloud', 'plus', 'lifetime', 'all_access'];
    for (var i = 0; i < names.length; i++) entitlements[names[i]] = entitlementObject();

    var subscriptions = {};
    subscriptions[PRODUCT] = subscriptionObject();

    return {
      entitlements: entitlements,
      subscriptions: subscriptions,
      non_subscriptions: {},
      first_seen: PURCHASE,
      last_seen: nowIso(),
      management_url: null,
      original_app_user_id: appUserId,
      original_application_version: '155',
      original_purchase_date: PURCHASE,
      other_purchases: {}
    };
  }

  function appUserIdOf(url) {
    var m = url.match(/\/v1\/subscribers\/([^\/?#]+)/);
    if (m && m[1]) {
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
    // receipts POST：URL 里没有 ID，从请求体里拿（app_user_id / app_user_id 兼容）
    try {
      var reqBody = ($request && $request.body) || '';
      if (reqBody) {
        var payload = JSON.parse(reqBody);
        var id = payload.app_user_id || payload.appUserId || payload.original_app_user_id;
        if (id) return String(id);
      }
    } catch (e) { /* 忽略，退回占位 */ }
    // identify 失败时 RC 会回落到匿名 ID，给个合法占位
    return '$RCAnonymousID:00000000000000000000000000000000';
  }

  function isSubscriberGet(method, path) {
    return method === 'GET' && /^\/v1\/subscribers\/[^\/?#]+$/.test(path);
  }

  function isReceiptsPost(method, path) {
    return method === 'POST' && /^\/v1\/receipts\/?$/.test(path);
  }

  /* ------------------------------------------------ 自有后端字段翻转 */

  var MEMBER_KEY_RE = /member|premium|vip|entitle|subscri|allaccess|all_access|paid|ispro|is_pro|trial/;
  var LOCK_KEY_RE = /lock|need|required|paywall|limited|blocked/;
  var EXPIRE_KEY_RE = /expir/;

  function rewriteNode(node, depth) {
    if (depth > 16 || node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      var arr = [];
      for (var i = 0; i < node.length; i++) arr.push(rewriteNode(node[i], depth + 1));
      return arr;
    }
    var out = {};
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var v = node[k];
      var lower = k.toLowerCase();

      if (typeof v === 'boolean') {
        if (LOCK_KEY_RE.test(lower) && !/unlock/.test(lower)) { out[k] = false; continue; }
        if (MEMBER_KEY_RE.test(lower)) { out[k] = true; continue; }
      } else if (typeof v === 'string' && EXPIRE_KEY_RE.test(lower)) {
        out[k] = EXPIRES;
        continue;
      } else if (typeof v === 'number' && EXPIRE_KEY_RE.test(lower)) {
        out[k] = 4102444800; // 2100-01-01 UTC
        continue;
      }

      out[k] = rewriteNode(v, depth + 1);
    }
    return out;
  }

  /* ------------------------------------------------------------- 分发 */

  function main() {
    var url = $request.url || '';
    var method = ($request.method || 'GET').toUpperCase();
    var host = '';
    var path = '';

    try {
      var u = new URL(url);
      host = u.hostname;
      path = u.pathname;
    } catch (e) {
      host = url.replace(/^https?:\/\//, '').split('/')[0];
      path = '/' + url.replace(/^https?:\/\/[^\/]+/, '').replace(/^\//, '').split('?')[0];
    }

    var status = ($response && $response.status) || 200;
    var headers = ($response && $response.headers) || {};
    var body = ($response && $response.body) || '';

    var isRC = RC_HOST_RE.test(host);

    if (isRC && (isSubscriberGet(method, path) || isReceiptsPost(method, path))) {
      var appUserId = appUserIdOf(url);
      var old = parseBody(body);
      if (old && old.subscriber && old.subscriber.original_app_user_id &&
          appUserId.indexOf('$RCAnonymousID:0000') === 0) {
        appUserId = old.subscriber.original_app_user_id;
      }

      var payload = {
        request_date: nowIso(),
        request_date_ms: Date.now(),
        subscriber: subscriberFor(appUserId)
      };

      // 304 / 空 body：SDK 会退回本地缓存，这里直接给 200 + 完整数据
      var outHeaders = {};
      for (var hk in headers) {
        if (!Object.prototype.hasOwnProperty.call(headers, hk)) continue;
        var lowerK = hk.toLowerCase();
        if (lowerK === 'content-length' || lowerK === 'content-encoding' ||
            lowerK === 'etag' || lowerK === 'x-revenuecat-etag' ||
            lowerK === 'x-revenuecat-fortress' || lowerK === 'x-rc-last-refresh-time') continue;
        outHeaders[hk] = headers[hk];
      }

      log((status === 304 ? '304->200 ' : status + ' ') + method + ' ' + host + path +
          ' -> allaccess active (' + appUserId + ')');
      return $done({ status: 200, headers: outHeaders, body: JSON.stringify(payload) });
    }

    if (isRC) {
      // identify / attributes / offerings / product_entitlement_mapping：原样放行
      return $done({});
    }

    // 自有后端：只翻会员字段，其余不动
    if (/^(.*\.)?untech\.cc$/.test(host)) {
      var obj = parseBody(body);
      if (!obj) return $done({});
      var rewritten = rewriteNode(obj, 0);
      return $done({
        status: status,
        headers: headers,
        body: JSON.stringify(rewritten)
      });
    }

    return $done({});
  }

  try {
    main();
  } catch (e) {
    log('error: ' + e);
    $done({});
  }
})();
