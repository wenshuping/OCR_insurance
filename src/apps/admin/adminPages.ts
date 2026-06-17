import {
  CircleHelp,
  Database,
  FileText,
  Globe2,
  LayoutDashboard,
  ListChecks,
  MessageSquareText,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';

export type AdminPageKey =
  | 'overview'
  | 'policies'
  | 'users'
  | 'reportIssues'
  | 'optionalResponsibilities'
  | 'knowledge'
  | 'officialDomains'
  | 'membership'
  | 'salesReview';

export type AdminPageMeta = {
  key: AdminPageKey;
  label: string;
  description: string;
  icon: LucideIcon;
};

export type AdminPageGroup = {
  group: string;
  items: AdminPageMeta[];
};

export const ADMIN_PAGE_GROUPS: AdminPageGroup[] = [
  {
    group: '总览',
    items: [
      { key: 'overview', label: '运营总览', description: '平台关键指标和待处理事项', icon: LayoutDashboard },
    ],
  },
  {
    group: '业务运营',
    items: [
      { key: 'policies', label: '保单运营', description: '查看保单、OCR 和责任报告', icon: FileText },
      { key: 'users', label: '用户', description: '查看注册用户和家庭列表', icon: Users },
    ],
  },
  {
    group: '质检治理',
    items: [
      { key: 'reportIssues', label: '报告问题', description: '查看家庭报告问题和修正记录', icon: ListChecks },
      { key: 'optionalResponsibilities', label: '可选责任缺口', description: '治理未量化的可选责任', icon: CircleHelp },
    ],
  },
  {
    group: '知识配置',
    items: [
      { key: 'knowledge', label: '产品知识库', description: '爬取和查看本地官方资料', icon: Database },
      { key: 'officialDomains', label: '官方域名', description: '维护保险公司官网白名单', icon: Globe2 },
    ],
  },
  {
    group: '系统',
    items: [
      { key: 'membership', label: '会员设置', description: '配置会员购买和免费额度', icon: Settings },
    ],
  },
];

export const ADMIN_PAGE_META: Record<AdminPageKey, AdminPageMeta> = Object.fromEntries(
  [
    ...ADMIN_PAGE_GROUPS.flatMap((group) => group.items),
    { key: 'salesReview', label: '销售建议', description: '只读查看已保存的家庭销售建议', icon: MessageSquareText },
  ].map((item) => [item.key, item]),
) as Record<AdminPageKey, AdminPageMeta>;
