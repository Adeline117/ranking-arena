// 元数据在 page.tsx：布局拿不到 searchParams，「有搜索词不收录」写在这里永远不生效。
export default function SearchLayout({ children }: { children: React.ReactNode }) {
  return children
}
