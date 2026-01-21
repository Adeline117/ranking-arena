'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import ContactSupportButton from '@/app/components/ui/ContactSupportButton'

export default function PrivacyPolicyPage() {
  return (
    <Box
      style={{
        maxWidth: 800,
        margin: '0 auto',
        padding: `${tokens.spacing[8]} ${tokens.spacing[4]}`,
      }}
    >
      <Text size="3xl" weight="bold" style={{ marginBottom: tokens.spacing[6] }}>
        隐私政策
      </Text>

      <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[8] }}>
        最后更新: 2026 年 1 月 18 日
      </Text>

      <Section title="1. 概述">
        <Paragraph>
          Arena（以下简称&ldquo;我们&rdquo;或&ldquo;本平台&rdquo;）重视您的隐私。本隐私政策说明了我们如何收集、使用、存储和保护您的个人信息。
        </Paragraph>
        <Paragraph>
          使用本平台即表示您同意本隐私政策中描述的数据处理方式。如果您不同意本政策的任何条款，请停止使用本平台。
        </Paragraph>
      </Section>

      <Section title="2. 我们收集的信息">
        <SubSection title="2.1 您主动提供的信息">
          <List items={[
            '账户信息：电子邮件地址、用户名、密码（加密存储）',
            '个人资料：显示名称、头像、个人简介',
            '用户生成内容：评价、投票',
            '通信内容：您与我们客服的沟通记录',
          ]} />
        </SubSection>

        <SubSection title="2.2 自动收集的信息">
          <List items={[
            '设备信息：浏览器类型、操作系统、设备标识符',
            '使用数据：访问时间、页面浏览、功能使用情况',
            '日志数据：IP 地址、请求来源、错误日志',
            'Cookie 和类似技术：会话管理、偏好设置',
          ]} />
        </SubSection>

        <SubSection title="2.3 第三方来源的信息">
          <List items={[
            '交易所公开数据：交易员排名、收益数据等',
            '社交登录：如您选择第三方登录，我们可能获取基本账户信息',
          ]} />
        </SubSection>
      </Section>

      <Section title="3. 信息使用目的">
        <Paragraph>
          我们使用收集的信息用于以下目的：
        </Paragraph>
        <List items={[
          '提供和维护平台服务',
          '处理您的注册和管理您的账户',
          '发送服务相关通知',
          '改进和优化用户体验',
          '分析使用趋势和平台性能',
          '防止欺诈和滥用行为',
          '遵守法律法规要求',
        ]} />
      </Section>

      <Section title="4. 信息共享">
        <Paragraph>
          我们不会出售您的个人信息。在以下情况下，我们可能会共享您的信息：
        </Paragraph>
        <List items={[
          '服务提供商：为运营平台所必需的第三方服务（如云托管、支付处理）',
          '法律要求：响应传票、法院命令或其他法律程序',
          '权利保护：保护我们、用户或公众的权利、隐私、安全或财产',
          '业务转让：在合并、收购或资产出售的情况下',
        ]} />
      </Section>

      <Section title="5. 数据安全">
        <Paragraph>
          我们采取合理的技术和组织措施保护您的信息：
        </Paragraph>
        <List items={[
          'HTTPS 加密传输所有数据',
          '密码使用行业标准算法加密存储',
          '定期安全审计和漏洞扫描',
          '严格的员工访问控制',
          '数据备份和灾难恢复计划',
        ]} />
        <Paragraph>
          但请注意，没有任何互联网传输或电子存储方法是 100% 安全的。
        </Paragraph>
      </Section>

      <Section title="6. 您的权利">
        <Paragraph>
          根据适用的数据保护法律，您可能拥有以下权利：
        </Paragraph>
        <List items={[
          '访问权：请求获取我们持有的关于您的信息副本',
          '更正权：要求更正不准确的个人信息',
          '删除权：要求删除您的个人信息（"被遗忘权"）',
          '数据可携权：要求以机器可读格式导出您的数据',
          '限制处理：在某些情况下限制我们处理您的信息',
          '撤回同意：撤回您之前给予的任何同意',
        ]} />
        <Paragraph>
          如需行使这些权利，请通过站内私信联系我们：
          <Box style={{ marginTop: tokens.spacing[2] }}>
            <ContactSupportButton variant="link" label="发送私信" />
          </Box>
        </Paragraph>
      </Section>

      <Section title="7. 数据保留">
        <Paragraph>
          我们会在实现收集目的所需的期限内保留您的信息。具体保留期限取决于：
        </Paragraph>
        <List items={[
          '账户数据：账户活跃期间及注销后 30 天',
          '交易记录：根据法律要求保留相应期限',
          '用户生成内容：可随时删除，或账户注销时一并删除',
          '日志数据：通常保留 90 天',
        ]} />
      </Section>

      <Section title="8. Cookie 政策">
        <Paragraph>
          我们使用以下类型的 Cookie：
        </Paragraph>
        <List items={[
          '必要 Cookie：维持登录状态和基本功能',
          '分析 Cookie：了解平台使用情况（可选）',
          '偏好 Cookie：记住您的设置偏好（可选）',
        ]} />
        <Paragraph>
          您可以通过浏览器设置管理 Cookie 偏好。禁用某些 Cookie 可能影响平台功能。
        </Paragraph>
      </Section>

      <Section title="9. 国际数据传输">
        <Paragraph>
          您的信息可能被传输到并存储在您所在国家/地区以外的服务器上。我们确保任何此类传输都符合适用的数据保护法律，并采取适当的保障措施。
        </Paragraph>
      </Section>

      <Section title="10. 未成年人">
        <Paragraph>
          本平台不面向 18 岁以下的未成年人。我们不会故意收集未成年人的个人信息。如果您发现我们无意中收集了未成年人的信息，请联系我们删除。
        </Paragraph>
      </Section>

      <Section title="11. 政策变更">
        <Paragraph>
          我们可能会不时更新本隐私政策。重大变更时，我们会通过电子邮件或平台通知告知您。继续使用本平台即表示您接受更新后的政策。
        </Paragraph>
      </Section>

      <Section title="12. 联系我们">
        <Paragraph>
          如果您对本隐私政策有任何疑问或需要行使您的权利，请通过站内私信联系我们：
        </Paragraph>
        <Box
          style={{
            padding: tokens.spacing[4],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            marginTop: tokens.spacing[3],
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[2],
          }}
        >
          <Text size="sm">联系客服处理隐私相关问题：</Text>
          <ContactSupportButton size="sm" label="发送私信给客服" />
        </Box>
      </Section>
    </Box>
  )
}

// ============================================
// 辅助组件
// ============================================

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box style={{ marginBottom: tokens.spacing[8] }}>
      <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
        {title}
      </Text>
      {children}
    </Box>
  )
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box style={{ marginBottom: tokens.spacing[4] }}>
      <Text size="lg" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
        {title}
      </Text>
      {children}
    </Box>
  )
}

function Paragraph({ children }: { children: React.ReactNode }) {
  return (
    <Text
      size="sm"
      color="secondary"
      style={{
        marginBottom: tokens.spacing[3],
        lineHeight: 1.7,
      }}
    >
      {children}
    </Text>
  )
}

function List({ items }: { items: string[] }) {
  return (
    <Box
      as="ul"
      style={{
        paddingLeft: tokens.spacing[5],
        marginBottom: tokens.spacing[4],
      }}
    >
      {items.map((item, index) => (
        <Box
          as="li"
          key={index}
          style={{
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.sm,
            lineHeight: 1.7,
            marginBottom: tokens.spacing[2],
          }}
        >
          {item}
        </Box>
      ))}
    </Box>
  )
}
