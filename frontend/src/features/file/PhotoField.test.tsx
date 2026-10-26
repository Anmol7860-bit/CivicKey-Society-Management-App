import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { ApiError } from '../auth/api'
import * as api from './api'
import { PhotoField, PrivateImage } from './PhotoField'

vi.mock('./api', async () => ({
  ...(await vi.importActual<typeof import('./api')>('./api')),
  uploadImage: vi.fn(),
  fetchImage: vi.fn(),
}))
const mocked = vi.mocked(api)

const image = (type = 'image/jpeg') => new File(['bytes'], 'photo.jpg', { type })

function Form() {
  const [reference, setReference] = useState('')
  return (
    <>
      <PhotoField id="photo" label="Photograph" accessToken="token" value={reference} onChange={setReference} required />
      <output>{reference || 'none'}</output>
    </>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  // jsdom has no object URLs
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
})

it('uploads the chosen photo at once and keeps the reference the form submits', async () => {
  mocked.uploadImage.mockResolvedValue({ id: 'file-1', contentType: 'image/jpeg', byteSize: 5 })
  render(<Form />)

  await userEvent.upload(screen.getByLabelText(/Photograph/), image())

  expect(await screen.findByText('file-1')).toBeInTheDocument()
  expect(mocked.uploadImage).toHaveBeenCalledWith('token', expect.any(File))
  expect(screen.getByAltText('Photo')).toHaveAttribute('src', 'blob:preview')
})

it('says what is wrong and holds no reference when the upload is refused', async () => {
  mocked.uploadImage.mockRejectedValue(new ApiError('INVALID_FILE', 'That image is larger than 5 MB.'))
  render(<Form />)

  await userEvent.upload(screen.getByLabelText(/Photograph/), image())

  expect(await screen.findByText('That image is larger than 5 MB.')).toBeInTheDocument()
  expect(screen.getByText('none')).toBeInTheDocument()
})

it('fetches a stored photo with the token, since an img tag cannot send one', async () => {
  mocked.fetchImage.mockResolvedValue(new Blob(['bytes']))
  render(<PrivateImage accessToken="token" reference="file-1" alt="Amit Kulkarni" />)

  expect(await screen.findByAltText('Amit Kulkarni')).toHaveAttribute('src', 'blob:preview')
  expect(mocked.fetchImage).toHaveBeenCalledWith('token', 'file-1')
})

it('shows a placeholder when the stored photo cannot be read', async () => {
  mocked.fetchImage.mockRejectedValue(new Error('gone'))
  render(<PrivateImage accessToken="token" reference="file-1" alt="Amit Kulkarni" />)

  expect(await screen.findByLabelText('Amit Kulkarni')).toBeInTheDocument()
})
