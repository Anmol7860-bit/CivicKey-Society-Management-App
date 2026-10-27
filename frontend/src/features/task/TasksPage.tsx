import { ListChecks, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, type Tone } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import { listSocieties } from '../society/api'
import { FormGrid, Panel, RowButton, useAction, useDeactivate } from '../society/parts'
import { useResource } from '../society/useResource'
import { listStaff } from '../staff/api'
import {
  createTask,
  listTasks,
  setTaskStatus,
  taskSummary,
  updateTask,
  type Task,
  type TaskBody,
  type TaskCategory,
  type TaskPriority,
  type TaskStatus,
} from './api'

const CATEGORIES: TaskCategory[] = ['PLUMBING', 'ELECTRICAL', 'HOUSEKEEPING', 'SECURITY', 'LIFT', 'PARKING', 'GARDEN', 'OTHER']
const PRIORITIES: TaskPriority[] = ['LOW', 'NORMAL', 'HIGH']
const STATUSES: TaskStatus[] = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']

const STATUS_TONE: Record<TaskStatus, Tone> = { OPEN: 'warning', IN_PROGRESS: 'brand', DONE: 'positive', CANCELLED: 'neutral' }
const PRIORITY_TONE: Record<TaskPriority, Tone> = { LOW: 'neutral', NORMAL: 'neutral', HIGH: 'danger' }

interface FormState {
  title: string
  details: string
  category: TaskCategory
  priority: TaskPriority
  location: string
  dueDate: string
  assignedStaffId: string
}

const emptyForm = (): FormState => ({
  title: '',
  details: '',
  category: 'OTHER',
  priority: 'NORMAL',
  location: '',
  dueDate: '',
  assignedStaffId: '',
})

/** One number on the strip above the list. */
function Stat({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: Tone }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-line bg-white p-4 shadow-card">
      <span className="text-[11px] font-bold tracking-wide text-muted uppercase">{label}</span>
      <span className={`text-[24px] leading-7 font-bold ${tone === 'danger' ? 'text-red-700' : 'text-ink'}`}>{value}</span>
    </div>
  )
}

function TaskRow({ task, token, staff, onChanged, onCancel }: {
  task: Task
  token: string
  staff: { value: string; label: string }[]
  onChanged: () => void
  onCancel: (task: Task) => void
}) {
  const { t } = useTranslation()
  const action = useAction()
  const closed = task.status === 'DONE' || task.status === 'CANCELLED'

  const move = (status: TaskStatus) =>
    action.run(() => setTaskStatus(token, task.id, { status })).then((ok) => ok && onChanged())
  const assign = (assignedStaffId: string) =>
    action.run(() => updateTask(token, task.id, { assignedStaffId: assignedStaffId || null })).then((ok) => ok && onChanged())

  const facts = [
    task.location,
    task.dueDate ? t('area.admin.tasks.due', { date: task.dueDate }) : null,
    task.raisedByName ? t('area.admin.tasks.raisedBy', { name: task.raisedByName }) : null,
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold text-ink">{task.title}</span>
        <Badge tone={STATUS_TONE[task.status]}>{t(`area.admin.tasks.status.${task.status}`)}</Badge>
        <Badge tone="neutral">{t(`area.admin.tasks.category.${task.category}`)}</Badge>
        {task.priority !== 'NORMAL' && (
          <Badge tone={PRIORITY_TONE[task.priority]}>{t(`area.admin.tasks.priority.${task.priority}`)}</Badge>
        )}
        {task.overdue && <Badge tone="danger">{t('area.admin.tasks.overdue')}</Badge>}
      </div>

      {task.details && <p className="text-[13px] text-ink-soft">{task.details}</p>}
      {facts.length > 0 && <p className="text-[12px] text-muted">{facts.join(' · ')}</p>}
      {task.closingNote && <p className="text-[12px] text-muted">{t('area.admin.tasks.closedWith', { note: task.closingNote })}</p>}

      {action.error && <p className="text-[12px] font-semibold text-red-700" role="alert">{action.error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {closed ? (
          <RowButton disabled={action.pending || task.status === 'CANCELLED'} onClick={() => move('OPEN')}>
            {t('area.admin.tasks.reopen')}
          </RowButton>
        ) : (
          <>
            <select
              aria-label={t('area.admin.tasks.assignLabel', { title: task.title })}
              value={task.assignedStaffId ?? ''}
              disabled={action.pending}
              onChange={(event) => assign(event.target.value)}
              className="h-9 cursor-pointer rounded-lg border border-line-strong bg-white px-2 text-[13px] text-ink-soft"
            >
              <option value="">{t('area.admin.tasks.unassigned')}</option>
              {staff.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {task.status === 'OPEN' && (
              <RowButton disabled={action.pending} onClick={() => move('IN_PROGRESS')}>
                {t('area.admin.tasks.start')}
              </RowButton>
            )}
            <button
              type="button"
              disabled={action.pending}
              onClick={() => move('DONE')}
              className="h-9 cursor-pointer rounded-lg bg-brand px-3 text-[13px] font-semibold text-white hover:bg-[#125a52] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('area.admin.tasks.done')}
            </button>
            <RowButton tone="danger" onClick={() => onCancel(task)}>
              {t('area.admin.tasks.cancel')}
            </RowButton>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The society's own work list: a leaking tank, a lift inspection, a light in the lobby. Raised by
 * the office and handed to staff or a vendor already registered, so the gate and the work list
 * talk about the same people.
 */
export function TasksPage({ accessToken }: { accessToken: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [filters, setFilters] = useState({ status: '', category: '', search: '', overdue: '' })
  const formPanel = useRef<HTMLElement>(null)
  const action = useAction()

  const societies = useResource(() => listSocieties(accessToken), [accessToken])
  const societyId = societies.data?.[0]?.id

  const query = {
    ...(filters.status ? { status: filters.status as TaskStatus } : {}),
    ...(filters.category ? { category: filters.category as TaskCategory } : {}),
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.overdue ? { overdue: 'true' as const } : {}),
  }
  const tasks = useResource(
    societyId ? () => listTasks(accessToken, societyId, query) : null,
    [accessToken, societyId, filters.status, filters.category, filters.search, filters.overdue],
  )
  const summary = useResource(societyId ? () => taskSummary(accessToken, societyId) : null, [accessToken, societyId, tasks.data])
  const staff = useResource(
    // Everyone who could be given a task fits in one page; the picker is a select, not a list
    societyId ? () => listStaff(accessToken, societyId, { status: 'ACTIVE', limit: 100 }) : null,
    [accessToken, societyId],
  )

  // The form opens below the list on a phone, so bring it into view
  useEffect(() => {
    if (open) formPanel.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [open])

  const staffOptions = (staff.data?.staff ?? [])
    .filter((member) => member.kind !== 'GUARD')
    .map((member) => ({ value: member.id, label: member.workType ? `${member.name} · ${member.workType}` : member.name }))

  const cancel = useDeactivate<Task>({
    title: t('area.admin.tasks.cancelTitle'),
    description: (task) => t('area.admin.tasks.cancelDescription', { title: task.title }),
    confirmLabel: t('area.admin.tasks.cancel'),
    onConfirm: async (task, note) => {
      await setTaskStatus(accessToken, task.id, { status: 'CANCELLED', note })
      tasks.reload()
    },
  })

  function reload() {
    tasks.reload()
    summary.reload()
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!societyId) return
    const body: TaskBody = {
      title: form.title.trim(),
      category: form.category,
      priority: form.priority,
      ...(form.details.trim() ? { details: form.details.trim() } : {}),
      ...(form.location.trim() ? { location: form.location.trim() } : {}),
      ...(form.dueDate ? { dueDate: form.dueDate } : {}),
      ...(form.assignedStaffId ? { assignedStaffId: form.assignedStaffId } : {}),
    }
    if (await action.run(() => createTask(accessToken, societyId, body))) {
      setCreated(body.title)
      setForm(emptyForm())
      setOpen(false)
      reload()
    }
  }

  if (societies.loading) return <Skeleton rows={6} />
  if (societies.error) return <ErrorState message={societies.error} onRetry={societies.reload} />

  const counts = summary.data

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.admin.tasks.title')}</h1>
        <p className="text-[13px] text-muted">{t('area.admin.tasks.intro')}</p>
      </header>

      {created && <SuccessNote message={t('area.admin.tasks.created', { title: created })} onDismiss={() => setCreated(null)} />}

      {counts && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label={t('area.admin.tasks.stats.open')} value={counts.open} />
          <Stat label={t('area.admin.tasks.stats.inProgress')} value={counts.inProgress} />
          <Stat label={t('area.admin.tasks.stats.overdue')} value={counts.overdue} tone={counts.overdue > 0 ? 'danger' : 'neutral'} />
          <Stat label={t('area.admin.tasks.stats.unassigned')} value={counts.unassigned} />
          <Stat label={t('area.admin.tasks.stats.doneThisMonth')} value={counts.doneThisMonth} />
        </div>
      )}

      <Panel
        title={t('area.admin.tasks.listTitle')}
        description={t('area.admin.tasks.listDescription')}
        action={
          <div className="w-[150px]">
            <Button type="button" onClick={() => setOpen(true)} icon={<Plus size={16} aria-hidden />}>
              {t('area.admin.tasks.add')}
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <TextField
            id="task-search"
            label={t('area.admin.tasks.search')}
            value={filters.search}
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
            placeholder={t('area.admin.tasks.searchPlaceholder')}
            maxLength={60}
          />
          <Select
            id="task-status"
            label={t('area.admin.tasks.filterStatus')}
            options={STATUSES.map((status) => ({ value: status, label: t(`area.admin.tasks.status.${status}`) }))}
            placeholder={t('area.admin.tasks.any')}
            value={filters.status}
            onChange={(event) => setFilters({ ...filters, status: event.target.value })}
          />
          <Select
            id="task-category"
            label={t('area.admin.tasks.filterCategory')}
            options={CATEGORIES.map((category) => ({ value: category, label: t(`area.admin.tasks.category.${category}`) }))}
            placeholder={t('area.admin.tasks.any')}
            value={filters.category}
            onChange={(event) => setFilters({ ...filters, category: event.target.value })}
          />
          <Select
            id="task-overdue"
            label={t('area.admin.tasks.filterOverdue')}
            options={[{ value: 'true', label: t('area.admin.tasks.overdueOnly') }]}
            placeholder={t('area.admin.tasks.any')}
            value={filters.overdue}
            onChange={(event) => setFilters({ ...filters, overdue: event.target.value })}
          />
        </div>

        {tasks.loading ? (
          <Skeleton rows={4} />
        ) : tasks.error ? (
          <ErrorState message={tasks.error} onRetry={tasks.reload} />
        ) : tasks.data?.length ? (
          <div className="overflow-hidden rounded-xl border border-line [&>*:first-child]:border-t-0">
            {tasks.data.map((task) => (
              <TaskRow key={task.id} task={task} token={accessToken} staff={staffOptions} onChanged={reload} onCancel={cancel.ask} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={ListChecks}
            title={t('area.admin.tasks.empty.title')}
            description={t('area.admin.tasks.empty.description')}
          />
        )}
      </Panel>

      {open && (
        <Panel ref={formPanel} title={t('area.admin.tasks.formTitle')} description={t('area.admin.tasks.formDescription')}>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
            <FormGrid>
              <TextField
                id="task-title"
                label={t('area.admin.tasks.fields.title')}
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                placeholder={t('area.admin.tasks.fields.titlePlaceholder')}
                error={action.fieldError('title')}
                maxLength={120}
                required
                autoFocus
              />
              <TextField
                id="task-location"
                label={t('area.admin.tasks.fields.location')}
                value={form.location}
                onChange={(event) => setForm({ ...form, location: event.target.value })}
                placeholder={t('area.admin.tasks.fields.locationPlaceholder')}
                maxLength={120}
              />
              <Select
                id="task-form-category"
                label={t('area.admin.tasks.fields.category')}
                options={CATEGORIES.map((category) => ({ value: category, label: t(`area.admin.tasks.category.${category}`) }))}
                value={form.category}
                onChange={(event) => setForm({ ...form, category: event.target.value as TaskCategory })}
              />
              <Select
                id="task-form-priority"
                label={t('area.admin.tasks.fields.priority')}
                options={PRIORITIES.map((priority) => ({ value: priority, label: t(`area.admin.tasks.priority.${priority}`) }))}
                value={form.priority}
                onChange={(event) => setForm({ ...form, priority: event.target.value as TaskPriority })}
              />
              <TextField
                id="task-due"
                type="date"
                label={t('area.admin.tasks.fields.dueDate')}
                value={form.dueDate}
                onChange={(event) => setForm({ ...form, dueDate: event.target.value })}
                error={action.fieldError('dueDate')}
              />
              <Select
                id="task-assignee"
                label={t('area.admin.tasks.fields.assignee')}
                options={staffOptions}
                placeholder={t('area.admin.tasks.unassigned')}
                hint={t('area.admin.tasks.fields.assigneeHint')}
                value={form.assignedStaffId}
                onChange={(event) => setForm({ ...form, assignedStaffId: event.target.value })}
              />
            </FormGrid>

            <TextField
              id="task-details"
              label={t('area.admin.tasks.fields.details')}
              value={form.details}
              onChange={(event) => setForm({ ...form, details: event.target.value })}
              placeholder={t('area.admin.tasks.fields.detailsPlaceholder')}
              maxLength={2000}
            />

            {action.error && <p className="text-[13px] font-semibold text-red-700" role="alert">{action.error}</p>}

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={action.pending || form.title.trim().length < 3}>
                {action.pending ? t('shell.saving') : t('area.admin.tasks.save')}
              </Button>
              <RowButton onClick={() => setOpen(false)}>{t('shell.cancel')}</RowButton>
            </div>
          </form>
        </Panel>
      )}
      {cancel.dialog}
    </div>
  )
}
