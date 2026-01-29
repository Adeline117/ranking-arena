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

## TC-EDGE: Edge Cases & Unusual Scenarios / 边界情况与异常场景

> Real-world edge cases that users might encounter. These tests simulate unusual but realistic situations.
>
> 用户可能遇到的真实边界情况。这些测试模拟不寻常但现实的场景。

---

### TC-EDGE-001: Network Disconnection During Post Submit
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Network / 网络 |

**Scenario / 场景:**
User writes a long post, network disconnects right when clicking "Post".

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Write a long post (500+ chars) | Content entered |
| 2 | Open DevTools → Network | Network tab ready |
| 3 | Set "Offline" mode | Network blocked |
| 4 | Click "Post" / "发布" | Loading starts |
| 5 | Observe behavior | Error message shown, NOT silent fail |
| 6 | Verify content preserved | Draft NOT lost |
| 7 | Go back online | Network restored |
| 8 | Retry submit | Post succeeds |
| 9 | Check for duplicates | Only ONE post created |

---

### TC-EDGE-002: Rapid Double-Click on Follow Button
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Race Condition / 竞态条件 |

**Scenario / 场景:**
User rapidly clicks follow button multiple times.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to trader profile | Page loaded |
| 2 | Rapidly click follow 5+ times | Clicks registered |
| 3 | Observe UI | Button disabled during request |
| 4 | Check final state | Either Following OR Not (not stuck) |
| 5 | Refresh page | State persists correctly |
| 6 | Check follower count | Count is accurate (not +5) |

---

### TC-EDGE-003: Same Account Login on Multiple Devices
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Session / 会话 |

**Scenario / 场景:**
User logs in on phone while already logged in on laptop.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Login on Device A (laptop) | Session active |
| 2 | Login on Device B (phone) | Second session active |
| 3 | Make changes on Device A | Changes saved |
| 4 | Refresh Device B | See Device A's changes |
| 5 | Logout on Device A | Device A logged out |
| 6 | Check Device B | Still logged in OR graceful re-auth |
| 7 | Perform action on Device B | Action succeeds or re-login prompt |

---

### TC-EDGE-004: Browser Back Button After Form Submit
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Navigation / 导航 |

**Scenario / 场景:**
User creates a post, then presses browser back button.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Create and submit a post | Post created, redirected |
| 2 | Click browser back button | Navigate back |
| 3 | Check form state | Empty form OR warning |
| 4 | Click forward button | Navigate forward |
| 5 | Check post | Post still exists (not duplicated) |
| 6 | Try to submit empty form | Validation prevents resubmit |

---

### TC-EDGE-005: Copy-Paste Formatted Text from Word/Notes
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Input / 输入 |

**Scenario / 场景:**
User copy-pastes formatted text with hidden characters from Microsoft Word.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | In Word, create text with bullets, bold, colors | Formatted text ready |
| 2 | Copy the text | Text in clipboard |
| 3 | Paste into post content | Text pasted |
| 4 | Check display | Plain text, no weird chars |
| 5 | Submit post | Post created |
| 6 | View post | Clean text displayed |
| 7 | Check for invisible characters | No \u200b, \ufeff, etc. |

---

### TC-EDGE-006: Emoji and Special Unicode Characters
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Unicode / 字符编码 |

**Scenario / 场景:**
User uses various emojis and special characters in content.

**Test Data:**
```
Standard emoji: 😀🎉🚀💰
Skin tone: 👋🏻👋🏿
Compound emoji: 👨‍👩‍👧‍👦 (family)
Flags: 🇨🇳🇺🇸🇯🇵
Symbols: ™©®℃№
Math: ∑∏∫√∞
RTL text: مرحبا العالم
Zero-width: test​test (has ZWSP)
Zalgo: T̵̢̧̨͓̱̦̪͔͔̣̦̼̮͚̹̗̝̮̺͎͉͐̂́̏̋́̂͐̍̅̎̚͘͠ͅͅḛ̷̡̛͎͙̪̫͈̣̳̖̥̥͂͆͑̋͋̅͊̿̋̿̉̓̌̀̕͘͜͝s̷̨̭͔̘̥͙̝̦̳̯̥̳̺͓̳̦̰̬̓̀̏̽t̵̡̞̪̣͔̼͔̺̳̔̀̓̔
```

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Enter all test data in bio | Field accepts input |
| 2 | Save bio | Saved successfully |
| 3 | View profile | All characters display correctly |
| 4 | Use in post title | Title saved |
| 5 | Use in comments | Comments saved |
| 6 | Search for emoji content | Search works |
| 7 | Check character count | Correct count (👨‍👩‍👧‍👦 = 1 char visually) |

---

### TC-EDGE-007: Extremely Long Continuous Text (No Spaces)
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Layout / 布局 |

**Scenario / 场景:**
User posts a very long string without any spaces or line breaks.

**Test Data:**
```
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Post 500 char string (no spaces) | Post created |
| 2 | View on desktop | Text wraps, no horizontal scroll |
| 3 | View on mobile | Text wraps, no overflow |
| 4 | Check container boundaries | Text doesn't break layout |
| 5 | Try in username/handle | Rejected or truncated |

---

### TC-EDGE-008: Session Expires During Long Form Fill
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Session / 会话 |

**Scenario / 场景:**
User spends 2 hours writing a detailed post, session expires before submit.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Login to app | Session active |
| 2 | Open post editor | Editor ready |
| 3 | Wait for session to expire (or manually expire) | Session expired |
| 4 | Enter long content (1000+ chars) | Content entered |
| 5 | Click "Post" | Submit attempted |
| 6 | Observe behavior | Re-login prompt, NOT data loss |
| 7 | Login again | Session restored |
| 8 | Check form | Content PRESERVED |
| 9 | Submit again | Post created successfully |

---

### TC-EDGE-009: Upload Image with Wrong Extension
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | File Upload / 文件上传 |

**Scenario / 场景:**
User renames a .exe file to .jpg and tries to upload.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Create fake image (rename .txt to .jpg) | File ready |
| 2 | Try to upload as avatar | Upload attempted |
| 3 | Observe result | Error: "Invalid image file" |
| 4 | Rename .exe to .png | File ready |
| 5 | Try to upload | Upload rejected |
| 6 | Check server response | MIME type validated |

---

### TC-EDGE-010: Timezone Change During Session
| Field | Value |
|-------|-------|
| Priority | P3 - Low |
| Category | Time / 时间 |

**Scenario / 场景:**
User travels from Beijing to New York while using the app.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Login in Beijing timezone (UTC+8) | Session active |
| 2 | Create a post at 10:00 AM Beijing | Post created |
| 3 | Change system timezone to New York (UTC-5) | Timezone changed |
| 4 | Refresh page | Page reloads |
| 5 | Check post timestamp | Shows relative time correctly |
| 6 | Check "posted X hours ago" | Calculation still correct |
| 7 | Schedule something (if feature exists) | Uses correct timezone |

---

### TC-EDGE-011: Rapid Tab Switching with Unsaved Changes
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Navigation / 导航 |

**Scenario / 场景:**
User has unsaved post draft, rapidly switches between tabs.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start writing a post | Content entered |
| 2 | Cmd/Ctrl + Click another link | New tab opens |
| 3 | Switch back to original tab | Tab still there |
| 4 | Check form content | Content preserved |
| 5 | Click in-page navigation | "Unsaved changes" warning |
| 6 | Cancel navigation | Stay on page |
| 7 | Click navigation again | Warning shown |
| 8 | Confirm leave | Navigate away |
| 9 | Go back | Form is empty (expected) |

---

### TC-EDGE-012: Payment Page Reload After Stripe Redirect
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Category | Payment / 支付 |

**Scenario / 场景:**
User completes Stripe payment but closes browser before redirect completes.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Initiate Pro subscription | Redirect to Stripe |
| 2 | Complete payment on Stripe | Payment successful |
| 3 | IMMEDIATELY close browser | Browser closed |
| 4 | Reopen browser | New session |
| 5 | Login to app | Session restored |
| 6 | Check subscription status | PRO status ACTIVE (webhook processed) |
| 7 | Check Stripe dashboard | Payment recorded |
| 8 | No duplicate charges | Only one charge |

---

### TC-EDGE-013: Simultaneous Edit Same Post (Two Tabs)
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Concurrency / 并发 |

**Scenario / 场景:**
User opens same post for editing in two browser tabs.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open post edit in Tab A | Edit form loaded |
| 2 | Open same post edit in Tab B | Edit form loaded |
| 3 | Change title in Tab A | Title changed |
| 4 | Change content in Tab B | Content changed |
| 5 | Save in Tab A | Saved successfully |
| 6 | Save in Tab B | Conflict handled OR overwrites |
| 7 | View final post | Consistent state |
| 8 | Check version/history (if exists) | Both edits recorded |

---

### TC-EDGE-014: Follow User Who Blocks You Mid-Request
| Field | Value |
|-------|-------|
| Priority | P3 - Low |
| Category | Race Condition / 竞态条件 |

**Scenario / 场景:**
User A clicks follow on User B. At the exact same moment, User B blocks User A.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | User A views User B profile | Profile displayed |
| 2 | User A clicks Follow | Request sent |
| 3 | Simultaneously, User B blocks User A | Block processed |
| 4 | Check User A's result | Error or "User not found" |
| 5 | User A refreshes | Profile not accessible |
| 6 | Check User A's following list | User B NOT in list |

---

### TC-EDGE-015: Upload During Low Storage on Mobile
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Mobile / 移动端 |

**Scenario / 场景:**
User tries to upload image when phone has <100MB storage left.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Fill phone storage to near-full | <100MB remaining |
| 2 | Try to select image for upload | File picker opens |
| 3 | Select large image (5MB) | Image selected |
| 4 | Observe behavior | App handles gracefully |
| 5 | If fails, error message | Clear error message |
| 6 | App doesn't crash | App remains stable |

---

### TC-EDGE-016: API Key with Special Characters
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Exchange / 交易所 |

**Scenario / 场景:**
User's exchange API secret contains special characters like +, /, =.

**Test Data:**
```
API Key: abc123XYZ
API Secret: aB+cD/eF==gH
Passphrase: p@ss+word/123=
```

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Go to exchange connection | Form displayed |
| 2 | Enter API key with special chars | Field accepts input |
| 3 | Enter secret with +, /, = | Field accepts input |
| 4 | Enter passphrase with special chars | Field accepts input |
| 5 | Submit connection | Validation attempted |
| 6 | Check encoding | Characters NOT corrupted |
| 7 | Connection works OR proper error | No garbled response |

---

### TC-EDGE-017: Language Switch Mid-Form
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | i18n / 国际化 |

**Scenario / 场景:**
User starts filling a form in Chinese, switches to English mid-way.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Set language to 中文 | Chinese UI |
| 2 | Start filling post form | Enter Chinese content |
| 3 | Switch language to English | UI changes |
| 4 | Check form | Content PRESERVED (not cleared) |
| 5 | Labels change | All labels now English |
| 6 | Submit form | Post created |
| 7 | View post | Chinese content displays correctly |

---

### TC-EDGE-018: Delete Account Then Try to Login
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Account / 账户 |

**Scenario / 场景:**
User requests account deletion, then tries to login during 30-day grace period.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Request account deletion | Deletion pending |
| 2 | Logout | Logged out |
| 3 | Try to login | Login form |
| 4 | Enter credentials | Attempt login |
| 5 | Observe result | Login succeeds with warning |
| 6 | See deletion notice | "Your account is scheduled for deletion" |
| 7 | Option to cancel | Cancel deletion available |
| 8 | Cancel deletion | Account restored |
| 9 | Login again normally | Normal access |

---

### TC-EDGE-019: Max Limit Testing
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Limits / 限制 |

**Scenario / 场景:**
Test behavior at maximum allowed limits.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Follow maximum traders (if limit) | Limit reached |
| 2 | Try to follow one more | Clear limit message |
| 3 | Create maximum posts per day | Limit reached |
| 4 | Try to create one more | Rate limit message |
| 5 | Join maximum groups | Limit reached |
| 6 | Try to join one more | Clear limit message |
| 7 | Upload maximum images per post | Limit reached |
| 8 | Try to add one more | Image rejected, others preserved |
| 9 | Create 100 bookmark folders | Limit behavior |

---

### TC-EDGE-020: Extremely Slow Network (2G Simulation)
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Network / 网络 |

**Scenario / 场景:**
User on very slow network (2G speed).

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | DevTools → Network → Slow 3G or custom 2G | Throttled |
| 2 | Load homepage | Page loads (slowly) |
| 3 | Check for loading indicators | Skeletons/spinners shown |
| 4 | Submit a post | Loading state visible |
| 5 | Wait for completion | Eventually completes OR timeout |
| 6 | Check timeout message | User-friendly timeout message |
| 7 | Try image upload | Progress indicator shown |
| 8 | Cancel slow upload | Cancel works |

---

### TC-EDGE-021: Password Manager Auto-fill Conflicts
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Browser / 浏览器 |

**Scenario / 场景:**
Password manager tries to auto-fill wrong fields.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Enable password manager (1Password, LastPass) | Manager active |
| 2 | Go to login page | Auto-fill may trigger |
| 3 | Check if correct fields filled | Email/password correct |
| 4 | Go to API key form | Form displayed |
| 5 | Check auto-fill behavior | Should NOT auto-fill API fields |
| 6 | API secret field | Should NOT show password suggestions |
| 7 | New user registration | Should NOT fill existing credentials |

---

### TC-EDGE-022: Mobile Keyboard Covers Submit Button
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Mobile / 移动端 |

**Scenario / 场景:**
On mobile, the keyboard covers important buttons.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open app on iPhone SE (small screen) | App loaded |
| 2 | Open post creation | Form displayed |
| 3 | Tap on content field | Keyboard opens |
| 4 | Check submit button visibility | Button visible OR scroll works |
| 5 | Scroll while keyboard open | Can scroll to button |
| 6 | Tap submit | Button responds |
| 7 | Open comment form | Form displayed |
| 8 | Same test | Submit accessible |

---

### TC-EDGE-023: External Link in Bio Causes XSS Attempt
| Field | Value |
|-------|-------|
| Priority | P0 - Critical |
| Category | Security / 安全 |

**Test Data:**
```
javascript:alert('XSS')
data:text/html,<script>alert('XSS')</script>
https://evil.com" onclick="alert('XSS')
https://example.com?q=<script>alert('XSS')</script>
```

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Try to save javascript: URL as website | Rejected OR sanitized |
| 2 | Try data: URL | Rejected OR sanitized |
| 3 | Try URL with onclick | Attribute stripped |
| 4 | Try URL with query XSS | Query encoded |
| 5 | View profile | No script execution |
| 6 | Click any saved links | Safe navigation only |

---

### TC-EDGE-024: Copy Trader with Deactivated Exchange Account
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Exchange / 交易所 |

**Scenario / 场景:**
Trader's exchange account gets banned/deactivated.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | View trader who was active | Profile loads |
| 2 | Trader's exchange account deactivated | Account removed from exchange |
| 3 | Next data sync | Sync runs |
| 4 | View trader profile | Appropriate status shown |
| 5 | Try to copy trade | Link may not work OR warning |
| 6 | Check leaderboard | Trader removed or flagged |

---

### TC-EDGE-025: Group Owner Deletes Account
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Group / 小组 |

**Scenario / 场景:**
The owner of a group with 1000 members deletes their account.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | As group owner, request account deletion | Deletion pending |
| 2 | Check group status | Group still exists |
| 3 | Check group ownership | Transferred OR pending |
| 4 | After 30 days, deletion completes | Account deleted |
| 5 | View group | Group has new owner OR admin |
| 6 | Group members | Can still access group |
| 7 | Group posts | Still visible |

---

### TC-EDGE-026: Bookmark Post Then Post Gets Deleted
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Data Integrity / 数据完整性 |

**Scenario / 场景:**
User bookmarks a post, then the post author deletes it.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | User A creates post | Post created |
| 2 | User B bookmarks post | Bookmark saved |
| 3 | User A deletes post | Post deleted |
| 4 | User B views bookmarks | Bookmark list loads |
| 5 | Check deleted bookmark | "Post no longer exists" OR removed |
| 6 | No broken links | Graceful handling |
| 7 | Bookmark count updated | Accurate count |

---

### TC-EDGE-027: Browser Zoom 200% / 50%
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Accessibility / 可访问性 |

**Scenario / 场景:**
User with vision issues uses browser zoom.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Set browser zoom to 200% | Page zoomed |
| 2 | Check layout | No horizontal scroll |
| 3 | Check buttons | All clickable, not overlapping |
| 4 | Check modals | Fully visible |
| 5 | Set zoom to 50% | Page zoomed out |
| 6 | Check readability | Text still readable |
| 7 | Check click targets | Still clickable |

---

### TC-EDGE-028: Multiple File Upload - One Fails
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Upload / 上传 |

**Scenario / 场景:**
User uploads 5 images, the 3rd one fails.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Select 5 images for upload | 5 files selected |
| 2 | One image is corrupted/invalid | Mixed valid/invalid |
| 3 | Start upload | Upload begins |
| 4 | Observe progress | Individual progress shown |
| 5 | Invalid image fails | Clear error for that image |
| 6 | Other 4 succeed | 4 images uploaded |
| 7 | Post can still be created | With 4 images |
| 8 | Option to retry failed | Retry available |

---

### TC-EDGE-029: Login With Caps Lock On
| Field | Value |
|-------|-------|
| Priority | P3 - Low |
| Category | UX / 用户体验 |

**Scenario / 场景:**
User accidentally has Caps Lock on while typing password.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Go to login page | Form displayed |
| 2 | Enter email normally | Email entered |
| 3 | Turn on Caps Lock | Caps Lock active |
| 4 | Type password | Password entered (wrong case) |
| 5 | Check for Caps Lock warning | Warning indicator shown |
| 6 | Submit | Login fails |
| 7 | Error message | "Invalid credentials" (not reveal password case issue) |

---

### TC-EDGE-030: Deep Link When Not Logged In
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Navigation / 导航 |

**Scenario / 场景:**
User clicks a shared link to protected content when not logged in.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Copy a private page URL (e.g., /settings/2fa) | URL copied |
| 2 | Open in incognito/new browser | Not logged in |
| 3 | Paste and navigate to URL | Navigation attempted |
| 4 | Observe behavior | Redirect to login |
| 5 | Login | Credentials entered |
| 6 | After login | Redirect BACK to original URL |
| 7 | Check original page | Page displays correctly |

---

### TC-EDGE-031: Stripe Webhook Delayed
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Payment / 支付 |

**Scenario / 场景:**
Stripe webhook is delayed by 5+ minutes after payment.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Complete payment on Stripe | Payment successful |
| 2 | Return to app immediately | Back in app |
| 3 | Check Pro status | May show "Processing" |
| 4 | Webhook delayed simulation | Wait or block webhook |
| 5 | User sees status | "Payment processing" message |
| 6 | Retry check button available | Manual refresh option |
| 7 | Webhook eventually arrives | Status updates to Pro |
| 8 | No duplicate charges | Only one charge in Stripe |

---

### TC-EDGE-032: Paste Image Directly into Text Field
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Input / 输入 |

**Scenario / 场景:**
User copies an image and pastes directly into post content.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Copy an image (screenshot or from web) | Image in clipboard |
| 2 | Open post editor | Editor displayed |
| 3 | Focus content field | Field focused |
| 4 | Cmd/Ctrl + V | Paste attempted |
| 5 | Observe behavior | Image uploaded OR ignored gracefully |
| 6 | If supported, image appears | Image shows in preview |
| 7 | If not supported | No crash, no garbled text |

---

### TC-EDGE-033: Right-to-Left (RTL) Language in Posts
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | i18n / 国际化 |

**Test Data:**
```
Arabic: مرحبا بكم في أرينا
Hebrew: שלום לכולם
Mixed: Hello مرحبا World عالم
```

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Create post with Arabic text | Post created |
| 2 | View post | Text displays RTL |
| 3 | Mix LTR and RTL | Both directions work |
| 4 | Check alignment | Proper alignment |
| 5 | Comment in Hebrew | Comment displays correctly |
| 6 | Search Arabic text | Search works |

---

### TC-EDGE-034: Trader Handle is Reserved Word
| Field | Value |
|-------|-------|
| Priority | P2 - Medium |
| Category | Data / 数据 |

**Scenario / 场景:**
Trader's handle matches a system reserved word or route.

**Test Data:**
- admin
- settings
- api
- login
- null
- undefined
- groups
- trader

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Search for trader "admin" | Search executed |
| 2 | If exists, view profile | Profile at /trader/admin |
| 3 | No conflict with /admin route | Different routes |
| 4 | Try to set username to "api" | Rejected (reserved) |
| 5 | Check error message | Clear "reserved word" message |

---

### TC-EDGE-035: WebSocket Disconnection During Chat
| Field | Value |
|-------|-------|
| Priority | P1 - High |
| Category | Real-time / 实时 |

**Scenario / 场景:**
WebSocket connection drops during active chat.

**Test Steps:**
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open chat with another user | Chat active |
| 2 | DevTools → Network → Offline | Connection lost |
| 3 | Other user sends message | Message sent |
| 4 | Check your chat | Reconnection indicator shown |
| 5 | Go back online | Connection restored |
| 6 | Check for missed message | Message appears |
| 7 | No message loss | All messages received |

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
