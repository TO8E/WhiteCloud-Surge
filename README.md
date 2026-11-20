# 白云天气 2.81 · Surge 会员解锁

## 结论

能。会员判定的数据源是 RevenueCat，不是自有后端：

| 链路 | 位置 | 判定 |
|---|---|---|
| RC 客户信息 | `GET https://api.revenuecat.com/v1/subscribers/{app_user_id}` | `subscriber.entitlements["allaccess"].isActive` |
| RC 收据校验 | `POST https://api.revenuecat.com/v1/receipts` | 同上 |
| 自有后端 | `https://untech.cc/api/v2/bootstrap`、`/api/v2/users/user-settings` | 会员布尔字段 |

二进制里那个 `allaccess` 判定函数（`patch_allaccess.py` 打的四处补丁）拿的就是 RC `CustomerInfo` 的 entitlements 字典，所以**只要让 RC 响应里 `allaccess` 一直 active，网络层就够用，不用重打包 IPA**。

## 文件

| 文件 | 作用 |
|---|---|
| `WhiteCloud.sgmodule` | Surge 模块：脚本规则 + MITM 域名 |
| `whitecloud_unlock.js` | 响应改写脚本（RC 客户信息 + 自有后端字段） |

## 仓库

- 仓库：<https://github.com/TO8E/WhiteCloud-Surge>
- 模块（raw）：<https://raw.githubusercontent.com/TO8E/WhiteCloud-Surge/main/WhiteCloud.sgmodule>
- 脚本（raw）：<https://raw.githubusercontent.com/TO8E/WhiteCloud-Surge/main/whitecloud_unlock.js>
- jsDelivr 镜像（raw 不通时）：<https://cdn.jsdelivr.net/gh/TO8E/WhiteCloud-Surge@main/WhiteCloud.sgmodule>

## 安装

1. Surge → 首页 → 模块 → 从 URL 安装，粘贴模块 raw 链接：
   `https://raw.githubusercontent.com/TO8E/WhiteCloud-Surge/main/WhiteCloud.sgmodule`
   （raw 不通就用 jsDelivr 镜像：`https://cdn.jsdelivr.net/gh/TO8E/WhiteCloud-Surge@main/WhiteCloud.sgmodule`）
2. Surge → 设置 → MITM → 生成并安装证书 → 到 iOS 设置里「通用 → 关于本机 → 证书信任设置」把 Surge 证书打开
3. MITM 开关打开，全局代理或规则模式都行
4. 模块里 `script-path` 已指向远端脚本，不用手动放文件
5. 杀掉白云天气 → 重开

## 验证

Surge → 请求记录里过滤 `revenuecat`，应看到：

```
GET  api.revenuecat.com/v1/subscribers/$RCAnonymousID:...
```

脚本日志（Surge → 脚本 → 日志）：

```
[WC-Unlock] 200 GET api.revenuecat.com/v1/subscribers/... -> allaccess active (...)
```

然后 App 内：会员页 / 小组件锁 / 会员功能逐个点一遍。RC 的 ETag 缓存已被脚本去掉，每次前台都会走一次网络。

## 边界与排障

1. **签名验证（最可能卡的地方）**
   App 如果开了 RC Trusted Entitlements（`entitlementVerificationMode = .enforced`），响应带 `X-RevenueCat-Fortress` 签名头，SDK 会校验 body，改一个字就报 `SIGNATURE_VERIFICATION_FAILED`，会员状态退回未订阅。
   判据：Surge 里能看到请求、脚本日志也命中，但 App 会员页没变化；或 App 日志出现该错误。这种情况下网络层改不动，只能回到 IPA 补丁路线（`build/` 里那套）。

2. **本地缓存**
   RC SDK 会在 UserDefaults 里缓存 CustomerInfo，App 前台刷新时才覆盖。装好模块后杀进程重开；如果还不行，卸载重装 App 清掉 `com.revenuecat.*` 缓存。

3. **小组件**
   小组件进程读 App Group 缓存，主 App 解锁后需要它自己刷新（切一次小组件 / 等系统周期刷新）。Surge 不改本地缓存，小组件首次可能仍是锁态。

4. **304**
   RC 会带 `If-None-Match`，服务端回 304 空 body，SDK 用本地缓存。脚本把 304 转成 200 + 完整客户信息，已处理。

5. **`untech.cc` 那条线**
   自有后端只是补充，脚本按字段名翻转（`member/premium/vip/entitle/allaccess` → true，`lock/need/paywall` → false，`expire` → 2100）。如果 App 后端字段命名特殊，改 `rewriteNode` 里的正则即可。

## 和 IPA 补丁的区别

| | Surge 重写 | IPA 补丁 |
|---|---|---|
| 改安装包 | 不改 | 改（重签） |
| 覆盖范围 | 只影响网络拉取，本地缓存/小组件另算 | 进程内全域 |
| 签名验证 | 会被 enforced 挡住 | 不受影响 |
| 升级 App | 模块继续可用 | 每次重打 |

两条路线可以并用：先上 Surge 验证接口和判定链路，确认是 RC 在管，再决定要不要走补丁。
