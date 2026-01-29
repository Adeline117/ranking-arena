# Ranking Arena - QA Test Cases
# 质量保证测试用例

> Professional test cases for all user operations in Ranking Arena.
>
> Ranking Arena 所有用户操作的专业测试用例。

---

## Document Info / 文档信息

| Item | Value |
|------|-------|
| Version | 1.0.0 |
| Last Updated | 2026-01-28 |
| Author | QA Team |
| Status | Active |

## Test Environment / 测试环境

| Environment | URL |
|-------------|-----|
| Production | https://www.arenafi.org |
| Staging | https://staging.arenafi.org |
| Local Dev | http://localhost:3000 |

## Test Accounts / 测试账号

| Role | Email | Password | Notes |
|------|-------|----------|-------|
| Free User | test.free@example.com | Test123! | 无订阅 |
| Pro User | test.pro@example.com | Test123! | Pro 订阅 |
| Admin | test.admin@example.com | Test123! | 管理员权限 |
| Group Owner | test.owner@example.com | Test123! | 小组创建者 |

---

## Table of Contents / 目录

1. [TC-AUTH: Authentication Tests](#tc-auth-authentication-tests)
2. [TC-PROFILE: User Profile Tests](#tc-profile-user-profile-tests)
3. [TC-TRADER: Trader Operations Tests](#tc-trader-trader-operations-tests)
4. [TC-POST: Post & Content Tests](#tc-post-post--content-tests)
5. [TC-COMMENT: Comment Tests](#tc-comment-comment-tests)
6. [TC-SOCIAL: Social Feature Tests](#tc-social-social-feature-tests)
7. [TC-MSG: Private Messaging Tests](#tc-msg-private-messaging-tests)
8. [TC-GROUP: Group Tests](#tc-group-group-tests)
9. [TC-NOTIF: Notification Tests](#tc-notif-notification-tests)
10. [TC-BOOKMARK: Bookmark Tests](#tc-bookmark-bookmark-tests)
11. [TC-SEARCH: Search Tests](#tc-search-search-tests)
12. [TC-PAY: Subscription & Payment Tests](#tc-pay-subscription--payment-tests)
13. [TC-EXCHANGE: Exchange Connection Tests](#tc-exchange-exchange-connection-tests)
14. [TC-SETTINGS: Settings Tests](#tc-settings-settings-tests)
15. [TC-I18N: Internationalization Tests](#tc-i18n-internationalization-tests)
16. [TC-MOBILE: Mobile Responsive Tests](#tc-mobile-mobile-responsive-tests)
17. [TC-PERF: Performance Tests](#tc-perf-performance-tests)
18. [TC-SEC: Security Tests](#tc-sec-security-tests)

---

## TC-AUTH: Authentication Tests

### TC-AUTH-001: Email Registration
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | User not logged in, valid email not registered |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/login` | Login page displayed |
| 2 | Click "Sign Up" / "注册" | Registration form displayed |
| 3 | Enter valid email | Email field accepts input |
| 4 | Enter password (min 8 chars, 1 uppercase, 1 number) | Password field accepts input |
| 5 | Confirm password | Passwords match validation |
| 6 | Click "Register" / "注册" | Loading state shown |
| 7 | Check email inbox | Verification email received |
| 8 | Click verification link | Account verified, redirected to app |

**Edge Cases:**
- [ ] Invalid email format → Error message displayed
- [ ] Password too weak → Strength indicator shows weak
- [ ] Email already registered → Error: "Email already in use"
- [ ] Passwords don't match → Error message displayed

---

### TC-AUTH-002: Email Login
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | User has registered account |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/login` | Login page displayed |
| 2 | Enter registered email | Email field accepts input |
| 3 | Enter correct password | Password field masked |
| 4 | Click "Login" / "登录" | Loading state shown |
| 5 | Wait for response | Redirected to homepage |
| 6 | Check navigation | User avatar/name shown in nav |

**Edge Cases:**
- [ ] Wrong password → Error: "Invalid credentials"
- [ ] Non-existent email → Error: "Invalid credentials"
- [ ] Empty fields → Validation error
- [ ] Too many failed attempts → Rate limit message

---

### TC-AUTH-003: Logout
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click user avatar in nav | Dropdown menu appears |
| 2 | Click "Logout" / "退出登录" | Confirmation or immediate logout |
| 3 | Observe page | Redirected to homepage |
| 4 | Check nav | Login button shown, no user info |
| 5 | Try accessing `/settings` | Redirected to login |

---

### TC-AUTH-004: Password Reset
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User has registered account |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/login` | Login page displayed |
| 2 | Click "Forgot Password" / "忘记密码" | Reset form displayed |
| 3 | Enter registered email | Email field accepts input |
| 4 | Click "Send Reset Link" / "发送重置链接" | Success message shown |
| 5 | Check email inbox | Reset email received |
| 6 | Click reset link | Password reset page opened |
| 7 | Enter new password | Password field accepts input |
| 8 | Confirm new password | Passwords match |
| 9 | Click "Reset Password" / "重置密码" | Success, redirected to login |
| 10 | Login with new password | Login successful |

---

### TC-AUTH-005: Account Deletion
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/settings` | Settings page displayed |
| 2 | Scroll to "Danger Zone" / "危险区域" | Delete account section visible |
| 3 | Click "Delete Account" / "删除账户" | Confirmation modal appears |
| 4 | Read warning message | 30-day grace period explained |
| 5 | Enter current password | Password field accepts input |
| 6 | Click "Confirm Delete" / "确认删除" | Account marked for deletion |
| 7 | Check email | Deletion confirmation email received |
| 8 | Try to login | Can still login during grace period |
| 9 | Click "Cancel Deletion" / "取消删除" | Deletion cancelled, account restored |

---

## TC-PROFILE: User Profile Tests

### TC-PROFILE-001: View Own Profile
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click user avatar in nav | Dropdown appears |
| 2 | Click "My Profile" / "我的主页" | Profile page loads |
| 3 | Verify URL | URL is `/u/[your-handle]` |
| 4 | Check header section | Avatar, name, bio displayed |
| 5 | Check following/followers | Counts displayed, clickable |
| 6 | Check joined groups | Groups section visible |
| 7 | Check posts section | User's posts displayed |

---

### TC-PROFILE-002: Edit Profile - Avatar Upload
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/settings` | Settings page displayed |
| 2 | Click on avatar or "Change Avatar" / "更换头像" | File picker opens |
| 3 | Select valid image (JPG/PNG, <5MB) | Image cropper modal appears |
| 4 | Adjust crop area | Preview updates in real-time |
| 5 | Adjust zoom slider | Image zooms in/out |
| 6 | Click "Confirm" / "确认" | Upload starts, loading shown |
| 7 | Wait for upload | Success toast appears |
| 8 | Check profile | New avatar displayed |

**Edge Cases:**
- [ ] File too large (>5MB) → Error message
- [ ] Invalid format (PDF, etc.) → Error message
- [ ] Cancel during crop → No changes saved

---

### TC-PROFILE-003: Edit Profile - Bio Update
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/settings` | Settings page displayed |
| 2 | Find "Bio" / "个人简介" field | Text area displayed |
| 3 | Enter new bio text (max 200 chars) | Character count updates |
| 4 | Click "Save" / "保存" | Loading state shown |
| 5 | Wait for response | Success toast appears |
| 6 | Navigate to profile | New bio displayed |

**Edge Cases:**
- [ ] Exceed 200 characters → Truncated or error
- [ ] Empty bio → Saved as empty (valid)
- [ ] Special characters/emoji → Properly saved and displayed

---

### TC-PROFILE-004: Edit Profile - Social Links
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/settings` | Settings page displayed |
| 2 | Find social links section | Twitter, Telegram, Discord fields |
| 3 | Enter Twitter handle (without @) | Field accepts input |
| 4 | Enter Telegram username | Field accepts input |
| 5 | Click "Save" / "保存" | Changes saved |
| 6 | Navigate to profile | Social links displayed with icons |
| 7 | Click social link | Opens correct external URL |

---

### TC-PROFILE-005: View Other User's Profile
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, target user exists |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/u/[other-handle]` | Profile page loads |
| 2 | Check header | User's avatar, name, bio displayed |
| 3 | Check follow button | "Follow" / "关注" button visible |
| 4 | Check message button | "Message" / "私信" button visible (if allowed) |
| 5 | Check followers (if public) | Follower count visible |
| 6 | Check posts section | User's public posts displayed |

---

## TC-TRADER: Trader Operations Tests

### TC-TRADER-001: View Leaderboard
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | None (works for guests) |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to homepage `/` | Leaderboard displayed |
| 2 | Check table headers | Rank, Trader, ROI, Win Rate, etc. visible |
| 3 | Check trader rows | At least 10 traders displayed |
| 4 | Scroll down | More traders load (infinite scroll or pagination) |
| 5 | Check exchange filter | Dropdown with Binance, Bybit, etc. |
| 6 | Select "Binance" | Table filters to Binance only |
| 7 | Check time range filter | 7D, 30D, 90D options |
| 8 | Select "7D" | Data updates for 7-day range |

---

### TC-TRADER-002: View Trader Detail Page
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | Trader exists in database |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click trader row on leaderboard | Navigate to `/trader/[handle]` |
| 2 | Check header section | Avatar, name, exchange badge visible |
| 3 | Check stats | ROI, Win Rate, Max Drawdown displayed |
| 4 | Check performance chart | Chart loads and renders |
| 5 | Check similar traders | Similar traders section visible |
| 6 | Check posts section | Trader's posts (if any) displayed |

---

### TC-TRADER-003: Follow/Unfollow Trader
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to trader detail page | Page loads |
| 2 | Find follow button | "Follow" / "关注" displayed |
| 3 | Click follow button | Button changes to "Following" / "关注中" |
| 4 | Check follower count | Count increases by 1 |
| 5 | Navigate to your following list | Trader appears in list |
| 6 | Return to trader page | Button still shows "Following" |
| 7 | Click "Following" button | Unfollow confirmation appears |
| 8 | Confirm unfollow | Button reverts to "Follow" |
| 9 | Check follower count | Count decreases by 1 |

---

### TC-TRADER-004: Claim Trader Account
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, has exchange connected, trader not claimed |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to unclaimed trader page | "Claim" / "申请认领" button visible |
| 2 | Click "Claim" / "申请认领" | Confirmation modal appears |
| 3 | Read requirements | Verification process explained |
| 4 | Click "Confirm" / "确认" | Verification starts |
| 5 | Wait for API check | System verifies ownership |
| 6 | If verified | Success message, page refreshes |
| 7 | Check trader page | Claimed badge visible |

**Edge Cases:**
- [ ] No exchange connected → Prompt to connect first
- [ ] Verification fails → Error message with reason
- [ ] Already claimed by another → Error: "Already claimed"

---

### TC-TRADER-005: Copy Trade Button (Pro Only)
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in as Pro |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to trader detail page | Page loads |
| 2 | Find copy trade button | Button visible for Pro users |
| 3 | Click copy trade button | Risk disclaimer modal appears |
| 4 | Read disclaimer | Risk warning text displayed |
| 5 | Check acknowledgment checkbox | Checkbox unchecked initially |
| 6 | Click "Proceed" without checking | Button disabled or error |
| 7 | Check acknowledgment checkbox | Checkbox checked |
| 8 | Click "Proceed" / "继续" | New tab opens to exchange |
| 9 | Verify URL | Correct exchange copy trade URL |

---

### TC-TRADER-006: Copy Trade Button (Free User)
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User logged in as Free user |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to trader detail page | Page loads |
| 2 | Find copy trade section | Locked/upgrade prompt visible |
| 3 | Click locked button | Redirected to pricing page |
| 4 | Check pricing page | Pro subscription options shown |

---

## TC-POST: Post & Content Tests

### TC-POST-001: Create Text Post
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to profile or group | Post creation area visible |
| 2 | Click "New Post" / "发动态" | Post editor opens |
| 3 | Enter title (1-200 chars) | Title field accepts input |
| 4 | Enter content (1-10000 chars) | Content field accepts input |
| 5 | Click "Post" / "发布" | Loading state shown |
| 6 | Wait for response | Success, post appears in feed |
| 7 | Check post | Title, content, timestamp correct |

**Edge Cases:**
- [ ] Empty title → Error: "Title required"
- [ ] Empty content → Error: "Content required"
- [ ] Title > 200 chars → Truncated or error
- [ ] Content > 10000 chars → Error message

---

### TC-POST-002: Create Post with Image
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open post editor | Editor displayed |
| 2 | Click image upload button | File picker opens |
| 3 | Select image (JPG/PNG/GIF, <10MB) | Image preview appears |
| 4 | Add multiple images (up to 9) | All previews shown |
| 5 | Click remove on one image | Image removed from preview |
| 6 | Enter title and content | Fields accept input |
| 7 | Click "Post" / "发布" | Upload progress shown |
| 8 | Wait for completion | Post created with images |
| 9 | Click on image in post | Image lightbox opens |

---

### TC-POST-003: Create Post with Poll
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open post editor | Editor displayed |
| 2 | Click "Add Poll" / "添加投票" | Poll options appear |
| 3 | Enter poll question | Question field accepts input |
| 4 | Enter option 1 | Option field accepts input |
| 5 | Enter option 2 | Second option field |
| 6 | Click "Add Option" | Third option field appears |
| 7 | Set poll duration | Duration dropdown works |
| 8 | Enter title and content | Fields accept input |
| 9 | Click "Post" / "发布" | Post created with poll |
| 10 | View post | Poll visible, voting available |

---

### TC-POST-004: Edit Post
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, owns the post |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to own post | Post displayed |
| 2 | Click "..." menu | Dropdown appears |
| 3 | Click "Edit" / "编辑" | Edit mode activated |
| 4 | Modify title | Title updates |
| 5 | Modify content | Content updates |
| 6 | Click "Save" / "保存" | Changes saved |
| 7 | View post | Updated content displayed |
| 8 | Check "Edited" indicator | Edit timestamp shown |

---

### TC-POST-005: Delete Post
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, owns the post |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to own post | Post displayed |
| 2 | Click "..." menu | Dropdown appears |
| 3 | Click "Delete" / "删除" | Confirmation modal appears |
| 4 | Read warning | Permanent deletion warning |
| 5 | Click "Cancel" / "取消" | Modal closes, post remains |
| 6 | Click "Delete" again | Confirmation modal appears |
| 7 | Click "Confirm Delete" / "确认删除" | Post deleted |
| 8 | Check feed | Post no longer visible |

---

### TC-POST-006: Like/Dislike Post
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to any post | Post displayed |
| 2 | Note current like count | Count visible |
| 3 | Click like button (upvote) | Button highlights, count +1 |
| 4 | Click like button again | Button unhighlights, count -1 |
| 5 | Click dislike button | Button highlights, dislike count +1 |
| 6 | Click like button | Dislike removed, like added |

---

### TC-POST-007: Bookmark Post
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to any post | Post displayed |
| 2 | Click bookmark icon | Bookmark modal or instant bookmark |
| 3 | Select folder (if modal) | Folder selected |
| 4 | Confirm bookmark | Icon fills/changes color |
| 5 | Navigate to bookmarks page | Post appears in bookmarks |
| 6 | Return to post | Bookmark icon still filled |
| 7 | Click bookmark icon again | Remove confirmation or instant |
| 8 | Confirm removal | Icon unfills |

---

### TC-POST-008: Vote on Poll
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User logged in, post has active poll |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to post with poll | Poll options visible |
| 2 | Results hidden before voting | Vote counts not visible |
| 3 | Click on an option | Option selected |
| 4 | Click "Vote" / "投票" | Vote submitted |
| 5 | View results | Percentages and counts visible |
| 6 | Try to vote again | Already voted message or disabled |

---

## TC-COMMENT: Comment Tests

### TC-COMMENT-001: Add Comment
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to any post | Post displayed |
| 2 | Scroll to comments section | Comment input visible |
| 3 | Enter comment (1-2000 chars) | Text field accepts input |
| 4 | Click "Comment" / "评论" | Loading state shown |
| 5 | Wait for response | Comment appears in list |
| 6 | Check comment | Your avatar, name, content, time |
| 7 | Check comment count | Post comment count +1 |

---

### TC-COMMENT-002: Reply to Comment
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, post has comments |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to post with comments | Comments visible |
| 2 | Click "Reply" / "回复" on comment | Reply input appears |
| 3 | Enter reply text | Text field accepts input |
| 4 | Click "Reply" / "回复" | Reply submitted |
| 5 | View comment thread | Reply appears nested under parent |
| 6 | Check @mention | Original commenter mentioned |

---

### TC-COMMENT-003: Like Comment
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to post with comments | Comments visible |
| 2 | Note comment like count | Count visible |
| 3 | Click like on comment | Icon highlights, count +1 |
| 4 | Click like again | Icon unhighlights, count -1 |

---

### TC-COMMENT-004: Delete Own Comment
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, owns a comment |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to post with your comment | Your comment visible |
| 2 | Click "..." on your comment | Dropdown appears |
| 3 | Click "Delete" / "删除" | Confirmation appears |
| 4 | Confirm delete | Comment removed |
| 5 | Check comment count | Post comment count -1 |

---

## TC-SOCIAL: Social Feature Tests

### TC-SOCIAL-001: Follow User
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to another user's profile | Profile displayed |
| 2 | Click "Follow" / "关注" | Button changes to "Following" |
| 3 | Check your following count | Count +1 |
| 4 | Check their follower count | Count +1 |
| 5 | Navigate to your following list | User appears in list |

---

### TC-SOCIAL-002: Unfollow User
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, following another user |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to followed user's profile | "Following" button visible |
| 2 | Click "Following" / "关注中" | Unfollow confirmation |
| 3 | Confirm unfollow | Button reverts to "Follow" |
| 4 | Check your following count | Count -1 |
| 5 | Check following list | User removed from list |

---

### TC-SOCIAL-003: View Followers List
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User logged in, has followers |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to your profile | Profile displayed |
| 2 | Click followers count | Followers modal/page opens |
| 3 | View follower list | List of users displayed |
| 4 | Click on a follower | Navigate to their profile |

---

### TC-SOCIAL-004: Block User
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to another user's profile | Profile displayed |
| 2 | Click "..." menu | Dropdown appears |
| 3 | Click "Block" / "屏蔽" | Confirmation appears |
| 4 | Confirm block | User blocked |
| 5 | Try to view their content | Content hidden or message shown |
| 6 | Go to settings → Block list | User appears in list |
| 7 | Click "Unblock" / "取消屏蔽" | User unblocked |

---

## TC-MSG: Private Messaging Tests

### TC-MSG-001: Start New Conversation
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, target allows messages |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to user's profile | Profile displayed |
| 2 | Click "Message" / "私信" | Chat window opens |
| 3 | Enter message text | Text field accepts input |
| 4 | Click send button | Message sent |
| 5 | Check conversation | Message appears in chat |
| 6 | Check inbox | New conversation listed |

---

### TC-MSG-002: Send Message in Existing Conversation
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, has existing conversation |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to inbox | Conversation list displayed |
| 2 | Click on conversation | Chat history loads |
| 3 | Enter new message | Text field accepts input |
| 4 | Click send | Message appears in chat |
| 5 | Check timestamp | Current time shown |

---

### TC-MSG-003: Receive Message Notification
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, another user sends message |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Wait for incoming message | Notification badge appears |
| 2 | Check notification icon | Unread count shown |
| 3 | Click notification | Navigate to message |
| 4 | Read message | Message marked as read |
| 5 | Check notification badge | Count decreases |

---

### TC-MSG-004: DM Privacy Settings
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to settings | Settings displayed |
| 2 | Find DM privacy setting | Options: All/Mutual/None |
| 3 | Select "Mutual only" / "仅互关" | Setting saved |
| 4 | Have non-mutual try to message | Message blocked or limited |
| 5 | Select "None" / "关闭" | Setting saved |
| 6 | Check your profile | Message button hidden/disabled |

---

## TC-GROUP: Group Tests

### TC-GROUP-001: Browse Groups
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | None |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/groups` | Groups page loads |
| 2 | View group cards | Name, description, member count |
| 3 | Use search | Filter by group name |
| 4 | Click sort options | Sort by members/activity |
| 5 | Click on group | Navigate to group detail |

---

### TC-GROUP-002: Join Free Group
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to free group | Group page displayed |
| 2 | Click "Join" / "加入" | Join confirmation |
| 3 | Confirm join | "Joined" / "已加入" shown |
| 4 | Check member count | Count +1 |
| 5 | Check your groups | Group appears in list |
| 6 | Can post in group | Post editor available |

---

### TC-GROUP-003: Leave Group
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User is group member |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to joined group | Group page displayed |
| 2 | Click "..." or settings | Options appear |
| 3 | Click "Leave Group" / "退出小组" | Confirmation appears |
| 4 | Confirm leave | Removed from group |
| 5 | Check your groups | Group removed from list |

---

### TC-GROUP-004: Apply to Create Group
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to create group page | Application form displayed |
| 2 | Enter group name (1-50 chars) | Field accepts input |
| 3 | Enter description (max 500 chars) | Field accepts input |
| 4 | Upload avatar | Image uploaded |
| 5 | Add rules | Rules fields appear |
| 6 | Click "Submit" / "提交" | Application submitted |
| 7 | Check status | "Pending" / "待审核" shown |

---

### TC-GROUP-005: Group Admin - Ban Member
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User is group admin |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to managed group | Group page displayed |
| 2 | Go to members section | Member list visible |
| 3 | Click "..." on member | Options appear |
| 4 | Click "Ban" / "封禁" | Ban confirmation |
| 5 | Confirm ban | Member banned |
| 6 | Check member status | "Banned" indicator shown |
| 7 | Banned user tries to post | Cannot post, error message |

---

## TC-NOTIF: Notification Tests

### TC-NOTIF-001: View Notifications
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, has notifications |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click notification bell | Notification panel opens |
| 2 | View notification list | Notifications displayed |
| 3 | Check notification types | Follow, like, comment, etc. |
| 4 | Click on notification | Navigate to related content |
| 5 | Check read status | Clicked notification marked read |

---

### TC-NOTIF-002: Mark All as Read
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User has unread notifications |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open notification panel | Unread count visible |
| 2 | Click "Mark all as read" / "全部已读" | All marked as read |
| 3 | Check notification badge | Badge disappears |
| 4 | Check notification list | All items show as read |

---

## TC-BOOKMARK: Bookmark Tests

### TC-BOOKMARK-001: Create Bookmark Folder
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to bookmarks page | Bookmarks displayed |
| 2 | Click "New Folder" / "新建文件夹" | Form appears |
| 3 | Enter folder name | Field accepts input |
| 4 | Set public/private | Toggle works |
| 5 | Click "Create" / "创建" | Folder created |
| 6 | Check folder list | New folder appears |

---

### TC-BOOKMARK-002: Move Bookmark to Folder
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User has bookmarks and folders |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to bookmarks | Bookmark list displayed |
| 2 | Click "..." on bookmark | Options appear |
| 3 | Click "Move to folder" / "移动到" | Folder list appears |
| 4 | Select target folder | Bookmark moved |
| 5 | Navigate to target folder | Bookmark visible there |
| 6 | Check original folder | Bookmark removed |

---

## TC-SEARCH: Search Tests

### TC-SEARCH-001: Search Traders
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | None |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click search bar | Search input focused |
| 2 | Type trader name | Suggestions appear |
| 3 | Press Enter or click suggestion | Results page loads |
| 4 | View trader results | Matching traders displayed |
| 5 | Click on trader | Navigate to trader page |

---

### TC-SEARCH-002: Search with Filters
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | None |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Enter search query | Results displayed |
| 2 | Click "Filters" / "筛选" | Filter panel opens |
| 3 | Select exchange filter | Results filtered |
| 4 | Set ROI range | Results filtered |
| 5 | Apply filters | Updated results shown |
| 6 | Clear filters | All results shown |

---

### TC-SEARCH-003: Search History
| Field | Value |
|-------|-------|
| Priority | P3 - Low |
| Precondition | User has searched before |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click search bar | Search input focused |
| 2 | View recent searches | History displayed |
| 3 | Click history item | Search executed |
| 4 | Click "Clear history" / "清除历史" | History cleared |

---

## TC-PAY: Subscription & Payment Tests

### TC-PAY-001: View Pricing Page
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in as free user |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `/pricing` | Pricing page loads |
| 2 | View subscription tiers | Free vs Pro comparison |
| 3 | Check monthly price | Price displayed correctly |
| 4 | Check yearly price | Discount shown |
| 5 | Check feature list | All Pro features listed |

---

### TC-PAY-002: Subscribe to Pro (Monthly)
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | User logged in, valid payment method |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to pricing page | Plans displayed |
| 2 | Click "Subscribe Monthly" / "月度订阅" | Redirect to Stripe |
| 3 | Enter test card (4242...) | Card accepted |
| 4 | Complete payment | Success page shown |
| 5 | Redirect back to app | Pro badge visible |
| 6 | Check settings | Subscription active |
| 7 | Access Pro features | Features unlocked |

**Test Card Numbers:**
- Success: 4242 4242 4242 4242
- Decline: 4000 0000 0000 0002
- Auth Required: 4000 0025 0000 3155

---

### TC-PAY-003: Cancel Subscription
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User has active Pro subscription |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to settings | Settings displayed |
| 2 | Find subscription section | Current plan shown |
| 3 | Click "Manage" / "管理订阅" | Stripe portal opens |
| 4 | Click "Cancel subscription" | Confirmation shown |
| 5 | Confirm cancellation | Subscription cancelled |
| 6 | Check access | Pro features until period end |
| 7 | After period end | Downgraded to free |

---

## TC-EXCHANGE: Exchange Connection Tests

### TC-EXCHANGE-001: Connect Exchange via API Key
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, has exchange API credentials |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to settings | Settings page displayed |
| 2 | Find "Exchange Connections" / "交易所连接" | Section visible |
| 3 | Click "Connect" / "连接" on exchange | Form appears |
| 4 | Enter API Key | Field accepts input |
| 5 | Enter API Secret | Field accepts input (masked) |
| 6 | Enter Passphrase (if Bitget) | Field accepts input |
| 7 | Click "Connect" / "连接" | Verification starts |
| 8 | Wait for verification | Connection established |
| 9 | Check connection status | "Connected" / "已连接" shown |

---

### TC-EXCHANGE-002: Disconnect Exchange
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User has connected exchange |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to settings | Settings displayed |
| 2 | Find connected exchange | "Connected" shown |
| 3 | Click "Disconnect" / "断开" | Confirmation appears |
| 4 | Confirm disconnect | Connection removed |
| 5 | Check status | "Not connected" shown |

---

### TC-EXCHANGE-003: Sync Exchange Data
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User has connected exchange |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to settings | Settings displayed |
| 2 | Find connected exchange | Last sync time shown |
| 3 | Click "Sync" / "同步" | Sync starts |
| 4 | Wait for completion | Success message |
| 5 | Check last sync time | Updated to current time |

---

## TC-SETTINGS: Settings Tests

### TC-SETTINGS-001: Change Language
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User on any page |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Find language switcher | Usually in nav or footer |
| 2 | Click language option | Dropdown appears |
| 3 | Select "English" | Page refreshes in English |
| 4 | Check all UI text | All text in English |
| 5 | Select "中文" | Page refreshes in Chinese |
| 6 | Check all UI text | All text in Chinese |

---

### TC-SETTINGS-002: Change Theme
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | User on any page |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Find theme toggle | Usually sun/moon icon |
| 2 | Click toggle (if dark) | Switch to light mode |
| 3 | Check background | Light background color |
| 4 | Check text | Dark text color |
| 5 | Click toggle again | Switch to dark mode |
| 6 | Check colors | Dark background, light text |

---

### TC-SETTINGS-003: Enable 2FA
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | User logged in, 2FA not enabled |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to settings | Settings displayed |
| 2 | Find 2FA section | "Enable 2FA" button |
| 3 | Click "Enable" / "启用" | QR code displayed |
| 4 | Scan with authenticator app | Code added to app |
| 5 | Enter 6-digit code | Verification field |
| 6 | Click "Verify" / "验证" | 2FA enabled |
| 7 | Check status | "Enabled" / "已启用" shown |
| 8 | Logout and login | 2FA prompt appears |
| 9 | Enter TOTP code | Login successful |

---

## TC-I18N: Internationalization Tests

### TC-I18N-001: All Pages Display Correctly in Both Languages
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | None |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Set language to English | Language set |
| 2 | Visit homepage | All text in English |
| 3 | Visit trader page | All text in English |
| 4 | Visit settings | All text in English |
| 5 | Switch to 中文 | Language set |
| 6 | Repeat all pages | All text in Chinese |
| 7 | Check for untranslated text | No mixed languages |
| 8 | Check for layout issues | Text fits in containers |

---

### TC-I18N-002: Date/Time Formatting
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | None |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Set to English | Language set |
| 2 | View timestamps | Format: "Jan 28" or "2h ago" |
| 3 | Set to 中文 | Language set |
| 4 | View timestamps | Format: "1月28日" or "2小时前" |

---

## TC-MOBILE: Mobile Responsive Tests

### TC-MOBILE-001: Navigation on Mobile
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | Mobile device or viewport < 768px |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open app on mobile | Mobile layout displayed |
| 2 | Check hamburger menu | Menu icon visible |
| 3 | Tap menu icon | Sidebar/drawer opens |
| 4 | Tap navigation item | Navigate to page |
| 5 | Check bottom nav | Bottom navigation visible |
| 6 | Tap bottom nav items | Navigate correctly |

---

### TC-MOBILE-002: Touch Interactions
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | Mobile device |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Pull down on feed | Refresh animation shown |
| 2 | Release | Content refreshes |
| 3 | Tap and hold on post | Context menu appears |
| 4 | Swipe on conversation | Delete/archive option |
| 5 | Pinch on image | Zoom works |

---

### TC-MOBILE-003: Forms on Mobile
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | Mobile device |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open post editor | Editor displayed |
| 2 | Tap text field | Keyboard opens |
| 3 | Type content | Text input works |
| 4 | Check keyboard doesn't cover buttons | Submit button visible |
| 5 | Submit form | Form submits successfully |

---

## TC-PERF: Performance Tests

### TC-PERF-001: Page Load Time
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | Network: 4G or Fast 3G |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open DevTools → Network | Network tab ready |
| 2 | Hard refresh homepage | Page loads |
| 3 | Check LCP | < 2.5s |
| 4 | Check FID | < 100ms |
| 5 | Check CLS | < 0.1 |
| 6 | Repeat for trader page | Same thresholds |
| 7 | Repeat for settings | Same thresholds |

---

### TC-PERF-002: Infinite Scroll Performance
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Precondition | Page with infinite scroll |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to leaderboard | Table displayed |
| 2 | Scroll continuously | More items load |
| 3 | Scroll 100+ items | No jank or freezing |
| 4 | Check memory usage | < 500MB |
| 5 | Check FPS | > 30 FPS during scroll |

---

## TC-SEC: Security Tests

### TC-SEC-001: XSS Prevention
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | User logged in |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Create post with `<script>alert('XSS')</script>` | Post created |
| 2 | View post | Script NOT executed |
| 3 | Check rendered HTML | Script tags escaped |
| 4 | Try in bio field | Same protection |
| 5 | Try in comment | Same protection |

---

### TC-SEC-002: CSRF Protection
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | Knowledge of API endpoints |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Copy a POST request | Request captured |
| 2 | Remove CSRF token | Token removed |
| 3 | Send request | 403 Forbidden |
| 4 | Try from different origin | 403 Forbidden |

---

### TC-SEC-003: Authentication Required
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Precondition | User logged out |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Try to access `/settings` | Redirected to login |
| 2 | Try to POST to `/api/posts` | 401 Unauthorized |
| 3 | Try to access DMs | Redirected to login |
| 4 | View public content | Works without login |

---

### TC-SEC-004: Rate Limiting
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Precondition | None |

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Send 100 requests in 1 minute | First ~50 succeed |
| 2 | Continue sending | 429 Too Many Requests |
| 3 | Wait 1 minute | Requests allowed again |
| 4 | Check rate limit headers | X-RateLimit headers present |

---

## Bug Report Template / 缺陷报告模板

```markdown
## Bug ID: BUG-XXXX

### Summary / 摘要
[One-line description]

### Environment / 环境
- Browser:
- OS:
- Device:
- User Type: Free/Pro/Admin

### Steps to Reproduce / 复现步骤
1.
2.
3.

### Expected Result / 预期结果
[What should happen]

### Actual Result / 实际结果
[What actually happened]

### Screenshots / 截图
[Attach if applicable]

### Severity / 严重程度
- [ ] P0 - Critical (Blocks testing/production)
- [ ] P1 - High (Major feature broken)
- [ ] P2 - Medium (Feature works with workaround)
- [ ] P3 - Low (Minor issue)

### Additional Notes / 备注
[Any other information]
```

---

## Test Execution Checklist / 测试执行清单

### Pre-Release Checklist / 发布前检查

- [ ] All P0 test cases passed
- [ ] All P1 test cases passed
- [ ] No open P0/P1 bugs
- [ ] Performance metrics met
- [ ] Security tests passed
- [ ] Mobile responsive verified
- [ ] Both languages verified
- [ ] Payment flow tested with test cards
- [ ] Cross-browser testing complete (Chrome, Safari, Firefox)

### Sign-off / 签署

| Role | Name | Date | Signature |
|------|------|------|-----------|
| QA Lead | | | |
| Dev Lead | | | |
| Product Owner | | | |

---

*Last updated: 2026-01-28*
