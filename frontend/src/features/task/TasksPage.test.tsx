import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as societyApi from '../society/api'
import * as staffApi from '../staff/api'
import type { Staff } from '../staff/api'
import * as api from './api'
import type { Task } from './api'
import { TasksPage } from './TasksPage'

vi.mock('./api')
vi.mock('../society/api')
vi.mock('../staff/api')
const mocked = vi.mocked(api)

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 't1',
  societyId: 's1',
  title: 'Lobby light is out',
  details: 'Second tube from the lift',
  category: 'ELECTRICAL',
  priority: 'NORMAL',
  status: 'OPEN',
  location: 'B wing lobby',
  dueDate: null,
  assignedStaffId: null,
  closedAt: null,
  closingNote: null,
  createdAt: '2026-10-23T09:00:00.000Z',
  updatedAt: '2026-10-23T09:00:00.000Z',
  assignee: null,
  raisedByName: 'Anita Rao',
  overdue: false,
  ...overrides,
})

const vendor = { id: 'st1', name: 'Mahesh', kind: 'VENDOR', phone: '9870000001', workType: 'Plumbing' } as Staff

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(societyApi).listSocieties.mockResolvedValue([{ id: 's1', name: 'Green Meadows' } as never])
  vi.mocked(staffApi).listStaff.mockResolvedValue([vendor])
  mocked.listTasks.mockResolvedValue([task()])
  mocked.taskSummary.mockResolvedValue({ open: 1, inProgress: 0, overdue: 0, unassigned: 1, doneThisMonth: 0 })
})

const show = () => render(<TasksPage accessToken="token" />)

it('shows the work list with its summary', async () => {
  mocked.taskSummary.mockResolvedValue({ open: 3, inProgress: 1, overdue: 2, unassigned: 1, doneThisMonth: 4 })
  show()

  expect(await screen.findByText('Lobby light is out')).toBeInTheDocument()
  expect(screen.getByText('Second tube from the lift')).toBeInTheDocument()
  expect(screen.getByText(/B wing lobby · Raised by Anita Rao/)).toBeInTheDocument()

  const overdue = screen.getByText('Past due').closest('div')!
  expect(within(overdue).getByText('2')).toBeInTheDocument()
})

it('raises a task with what the office typed', async () => {
  mocked.createTask.mockResolvedValue(task({ title: 'Lift inspection' }))
  show()
  await userEvent.click(await screen.findByRole('button', { name: 'Add task' }))

  await userEvent.type(screen.getByLabelText(/What needs doing/), 'Lift inspection')
  await userEvent.type(screen.getByLabelText(/^Where/), 'A wing')
  await userEvent.selectOptions(screen.getByLabelText(/Category/, { selector: '#task-form-category' }), 'LIFT')
  await userEvent.selectOptions(screen.getByLabelText(/Priority/), 'HIGH')
  await userEvent.type(screen.getByLabelText(/Due by/), '2026-11-30')
  await userEvent.selectOptions(screen.getByLabelText(/Hand it to/), 'st1')
  await userEvent.click(screen.getByRole('button', { name: 'Raise task' }))

  await waitFor(() =>
    expect(mocked.createTask).toHaveBeenCalledWith('token', 's1', {
      title: 'Lift inspection',
      category: 'LIFT',
      priority: 'HIGH',
      location: 'A wing',
      dueDate: '2026-11-30',
      assignedStaffId: 'st1',
    }),
  )
  expect(await screen.findByText(/is on the work list/)).toBeInTheDocument()
})

it('offers only daily help and vendors as the people who do the work', async () => {
  vi.mocked(staffApi).listStaff.mockResolvedValue([vendor, { ...vendor, id: 'st2', name: 'Mahesh Patil', kind: 'GUARD' } as Staff])
  show()

  const assign = await screen.findByLabelText('Who is doing “Lobby light is out”')
  expect(within(assign).getByRole('option', { name: 'Mahesh · Plumbing' })).toBeInTheDocument()
  expect(within(assign).queryByRole('option', { name: /Mahesh Patil/ })).not.toBeInTheDocument()
})

it('hands a task to someone from the list', async () => {
  mocked.updateTask.mockResolvedValue(task({ assignedStaffId: 'st1' }))
  show()

  await userEvent.selectOptions(await screen.findByLabelText('Who is doing “Lobby light is out”'), 'st1')

  await waitFor(() => expect(mocked.updateTask).toHaveBeenCalledWith('token', 't1', { assignedStaffId: 'st1' }))
})

it('moves a task along and reopens a finished one', async () => {
  mocked.setTaskStatus.mockResolvedValue(task({ status: 'IN_PROGRESS' }))
  show()

  await userEvent.click(await screen.findByRole('button', { name: 'Start' }))
  expect(mocked.setTaskStatus).toHaveBeenCalledWith('token', 't1', { status: 'IN_PROGRESS' })

  mocked.listTasks.mockResolvedValue([task({ status: 'DONE', closedAt: '2026-10-23T11:00:00.000Z', closingNote: 'New tube fitted' })])
  mocked.setTaskStatus.mockResolvedValue(task())
  await userEvent.click(screen.getByRole('button', { name: 'Mark done' }))

  expect(await screen.findByText('Closed: New tube fitted')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Reopen' }))
  expect(mocked.setTaskStatus).toHaveBeenLastCalledWith('token', 't1', { status: 'OPEN' })
})

it('asks why before cancelling', async () => {
  mocked.setTaskStatus.mockResolvedValue(task({ status: 'CANCELLED' }))
  show()

  await userEvent.click(await screen.findByRole('button', { name: 'Cancel task' }))
  const dialog = screen.getByRole('dialog')
  await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Raised twice')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel task' }))

  await waitFor(() =>
    expect(mocked.setTaskStatus).toHaveBeenCalledWith('token', 't1', { status: 'CANCELLED', note: 'Raised twice' }),
  )
})

it('filters the list', async () => {
  show()
  await screen.findByText('Lobby light is out')

  await userEvent.selectOptions(screen.getByLabelText(/Status/), 'DONE')
  await waitFor(() => expect(mocked.listTasks).toHaveBeenLastCalledWith('token', 's1', { status: 'DONE' }))

  await userEvent.selectOptions(screen.getByLabelText(/Due date/), 'true')
  await waitFor(() => expect(mocked.listTasks).toHaveBeenLastCalledWith('token', 's1', { status: 'DONE', overdue: 'true' }))
})

it('marks an overdue task on the row', async () => {
  mocked.listTasks.mockResolvedValue([task({ dueDate: '2020-01-01', overdue: true, priority: 'HIGH' })])
  show()

  const row = (await screen.findByText('Lobby light is out')).closest('div')!
  expect(within(row).getByText('Overdue')).toBeInTheDocument()
  expect(within(row).getByText('High')).toBeInTheDocument()
  expect(screen.getByText(/Due 2020-01-01/)).toBeInTheDocument()
})
