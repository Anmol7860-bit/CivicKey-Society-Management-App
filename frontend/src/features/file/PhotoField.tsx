import { ImageOff, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Field } from '../../components/ui/Field'
import { ApiError } from '../auth/api'
import { ACCEPTED_TYPES, fetchImage, uploadImage } from './api'

/**
 * A stored photo on screen.
 *
 * The endpoint wants the access token, which an `<img src>` cannot send, so the bytes are fetched
 * and shown from an object URL that is released when the image goes away.
 */
export function PrivateImage({
  accessToken,
  reference,
  alt,
  className = '',
}: {
  accessToken: string
  reference: string
  alt: string
  className?: string
}) {
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let objectUrl: string | undefined
    fetchImage(accessToken, reference).then(
      (blob) => {
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      },
      () => setFailed(true),
    )
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      setUrl(undefined)
      setFailed(false)
    }
  }, [accessToken, reference])

  if (failed) {
    return (
      <span className={`flex items-center justify-center bg-canvas text-muted ${className}`}>
        <ImageOff size={16} aria-label={alt} />
      </span>
    )
  }
  return url ? <img src={url} alt={alt} className={className} /> : <span className={`animate-pulse bg-canvas ${className}`} />
}

interface PhotoFieldProps {
  id: string
  label: string
  accessToken: string
  /** The stored reference, or '' for none */
  value: string
  onChange: (reference: string) => void
  error?: string
  required?: boolean
}

/**
 * Chooses a photo, uploads it at once and keeps the reference the form submits.
 *
 * The preview is the local file, so nothing is downloaded again; an already stored photo is shown
 * through PrivateImage. The upload happens on choosing rather than on submit, so a slow upload
 * never holds up the rest of the form and its own error stays beside the field.
 */
export function PhotoField({ id, label, accessToken, value, onChange, error, required }: PhotoFieldProps) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])

  async function choose(file: File | undefined) {
    if (!file) return
    setFailure(undefined)
    setBusy(true)
    try {
      const stored = await uploadImage(accessToken, file)
      setPreview(URL.createObjectURL(file))
      onChange(stored.id)
    } catch (problem) {
      setFailure(problem instanceof ApiError ? problem.message : String(problem))
      onChange('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field id={id} label={label} error={error ?? failure} hint={t('photo.hint')} required={required}>
      <div className="flex items-center gap-3">
        <span className="flex size-[52px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-canvas">
          {preview ? (
            <img src={preview} alt={t('photo.preview')} className="size-full object-cover" />
          ) : value ? (
            <PrivateImage accessToken={accessToken} reference={value} alt={t('photo.preview')} className="size-full object-cover" />
          ) : (
            <Upload size={16} className="text-muted" aria-hidden />
          )}
        </span>
        <input
          id={id}
          type="file"
          accept={ACCEPTED_TYPES.join(',')}
          disabled={busy}
          onChange={(event) => void choose(event.target.files?.[0])}
          aria-invalid={error ?? failure ? true : undefined}
          aria-describedby={`${id}-message`}
          className="text-[13px] text-muted file:mr-3 file:h-9 file:cursor-pointer file:rounded-lg file:border file:border-line-strong file:bg-white file:px-3 file:text-[13px] file:font-semibold file:text-ink"
        />
        {busy && <span className="text-[12px] text-muted">{t('photo.uploading')}</span>}
      </div>
    </Field>
  )
}
