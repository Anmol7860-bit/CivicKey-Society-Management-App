import {
  ArrowLeftRight,
  BadgeCheck,
  Bell,
  Building2,
  ChartNoAxesCombined,
  CloudCheck,
  Contact,
  CreditCard,
  FileChartColumn,
  HeartHandshake,
  History,
  Home,
  LayoutDashboard,
  ListChecks,
  MapPin,
  QrCode,
  Receipt,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  UserCheck,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { AuthUser, Permission, Role } from '../auth/api'

/** Shown when the user has any of these permissions; omitted means every user of the role */
interface Gated {
  key: string
  icon: LucideIcon
  anyOf?: Permission[]
}

interface Destination extends Gated {
  /** Path segment under the area, e.g. "overview" for /resident/overview */
  path: string
}

export interface AreaConfig {
  area: 'resident' | 'guard' | 'admin'
  /** The nav destination that renders the dashboard */
  home: string
  nav: Destination[]
  /** The one button in the overview header; omitted when the role's overview carries none */
  primaryAction?: Destination
  stats: Gated[]
  shortcuts: Destination[]
}

const BILLING: Permission[] = ['BILLING_RATE_SET', 'INVOICE_GENERATE', 'PAYMENT_CASH_MARK']

// Navigation, actions and summaries per role, from the Figma "RBAC frontend solution design".
// Text lives in i18n under area.<area>.<group>.<key>.
export const AREAS: Record<Role, AreaConfig> = {
  RESIDENT: {
    area: 'resident',
    home: 'overview',
    nav: [
      { key: 'overview', path: 'overview', icon: LayoutDashboard },
      { key: 'myFlat', path: 'my-flat', icon: Home, anyOf: ['VISIT_VIEW_OWN'] },
      { key: 'visitorApproval', path: 'visitor-approval', icon: UserCheck, anyOf: ['VISITOR_APPROVE'] },
      { key: 'dailyHelp', path: 'daily-help', icon: HeartHandshake },
      { key: 'bills', path: 'bills', icon: CreditCard, anyOf: ['BILL_VIEW_OWN', 'BILL_PAY', 'RECEIPT_VIEW_OWN'] },
      { key: 'notifications', path: 'notifications', icon: Bell },
      { key: 'activity', path: 'activity', icon: History, anyOf: ['VISIT_VIEW_OWN'] },
    ],
    stats: [
      { key: 'awaiting', icon: UserCheck, anyOf: ['VISITOR_APPROVE'] },
      { key: 'passes', icon: QrCode, anyOf: ['VISITOR_PASS_CREATE'] },
      { key: 'bills', icon: Receipt, anyOf: ['BILL_VIEW_OWN'] },
    ],
    shortcuts: [
      { key: 'visitorApproval', path: 'visitor-approval', icon: UserCheck, anyOf: ['VISITOR_APPROVE'] },
      { key: 'bills', path: 'bills', icon: CreditCard, anyOf: ['BILL_VIEW_OWN', 'BILL_PAY'] },
    ],
  },
  GUARD: {
    area: 'guard',
    home: 'operations',
    nav: [
      { key: 'operations', path: 'operations', icon: LayoutDashboard },
      { key: 'visitorRegistration', path: 'visitor-registration', icon: UserPlus, anyOf: ['VISIT_REGISTER'] },
      { key: 'passValidation', path: 'pass-validation', icon: ScanLine, anyOf: ['PASS_VALIDATE'] },
      { key: 'gate', path: 'gate', icon: History, anyOf: ['VISIT_ENTRY_RECORD', 'VISIT_EXIT', 'VISIT_DECIDE'] },
      { key: 'sync', path: 'sync', icon: RefreshCw },
    ],
    primaryAction: { key: 'registerVisitor', path: 'visitor-registration', icon: UserPlus, anyOf: ['VISIT_REGISTER'] },
    stats: [
      { key: 'expected', icon: Users },
      { key: 'onSite', icon: MapPin },
      { key: 'sync', icon: CloudCheck },
    ],
    shortcuts: [
      { key: 'registerVisitor', path: 'visitor-registration', icon: UserPlus, anyOf: ['VISIT_REGISTER'] },
      { key: 'validatePass', path: 'pass-validation', icon: ScanLine, anyOf: ['PASS_VALIDATE'] },
      { key: 'entryExit', path: 'gate', icon: ArrowLeftRight, anyOf: ['VISIT_ENTRY_RECORD', 'VISIT_EXIT'] },
    ],
  },
  ADMIN: {
    area: 'admin',
    home: 'overview',
    nav: [
      { key: 'overview', path: 'overview', icon: LayoutDashboard },
      { key: 'addUser', path: 'add-user', icon: UserPlus, anyOf: ['USER_MANAGE'] },
      { key: 'society', path: 'society', icon: Building2, anyOf: ['SOCIETY_MANAGE', 'USER_MANAGE'] },
      { key: 'staff', path: 'staff', icon: Contact, anyOf: ['GUARD_MANAGE', 'STAFF_MANAGE'] },
      { key: 'staffMovement', path: 'staff-movement', icon: BadgeCheck, anyOf: ['STAFF_MANAGE', 'AUDIT_VIEW'] },
      { key: 'security', path: 'security', icon: ShieldCheck, anyOf: ['AUDIT_VIEW'] },
      { key: 'billing', path: 'billing', icon: Receipt, anyOf: BILLING },
      { key: 'reports', path: 'reports', icon: ChartNoAxesCombined, anyOf: ['REPORT_VIEW'] },
      { key: 'tasks', path: 'tasks', icon: ListChecks, anyOf: ['SOCIETY_MANAGE'] },
      // A committee member is a Resident first. These carry the RESIDENT role's permissions, so a
      // staff Admin — who holds none of them — never sees them.
      { key: 'myFlat', path: 'my-flat', icon: Home, anyOf: ['VISIT_VIEW_OWN'] },
      { key: 'visitorApproval', path: 'visitor-approval', icon: UserCheck, anyOf: ['VISITOR_APPROVE'] },
      { key: 'bills', path: 'bills', icon: CreditCard, anyOf: ['BILL_VIEW_OWN', 'BILL_PAY', 'RECEIPT_VIEW_OWN'] },
      { key: 'activity', path: 'activity', icon: History, anyOf: ['VISIT_VIEW_OWN'] },
    ],
    primaryAction: { key: 'addUser', path: 'add-user', icon: UserPlus, anyOf: ['USER_MANAGE'] },
    stats: [
      { key: 'occupancy', icon: Building2, anyOf: ['SOCIETY_MANAGE'] },
      { key: 'users', icon: Users, anyOf: ['USER_MANAGE', 'GUARD_MANAGE', 'STAFF_MANAGE'] },
      { key: 'billing', icon: ChartNoAxesCombined, anyOf: [...BILLING, 'REPORT_VIEW'] },
    ],
    shortcuts: [
      { key: 'society', path: 'society', icon: Building2, anyOf: ['SOCIETY_MANAGE', 'USER_MANAGE'] },
      { key: 'staff', path: 'staff', icon: Contact, anyOf: ['GUARD_MANAGE', 'STAFF_MANAGE'] },
      { key: 'billingReports', path: 'billing', icon: FileChartColumn, anyOf: BILLING },
    ],
  },
}

export function allowed(user: AuthUser, item: Gated) {
  return !item.anyOf || item.anyOf.some((permission) => user.permissions.includes(permission))
}

export function homePath(role: Role) {
  return `/${AREAS[role].area}/${AREAS[role].home}`
}
