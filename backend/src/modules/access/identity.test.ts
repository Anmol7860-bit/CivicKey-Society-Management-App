import { decryptIdNumber, identityOf, withoutHash } from './identity.js'

it('keeps the type, the lookup hash, the last four and the number as ciphertext', () => {
  const columns = identityOf({ idDocumentType: 'AADHAAR', idNumber: '123456789012' })

  expect(columns.idDocumentLast4).toBe('9012')
  expect(columns.idDocumentHash).toMatch(/^[0-9a-f]{64}$/)
  expect(columns.idDocumentEncrypted).not.toContain('123456789012')
  expect(decryptIdNumber(columns.idDocumentEncrypted)).toBe('123456789012')
})

it('gives the same number the same lookup hash and a different ciphertext', () => {
  const first = identityOf({ idDocumentType: 'PAN', idNumber: 'ABCDE1234F' })
  const second = identityOf({ idDocumentType: 'PAN', idNumber: 'ABCDE1234F' })

  // The hash is what finds a duplicate; the ciphertext has its own nonce every time
  expect(second.idDocumentHash).toBe(first.idDocumentHash)
  expect(second.idDocumentEncrypted).not.toBe(first.idDocumentEncrypted)
})

it('refuses ciphertext that has been tampered with rather than returning a wrong number', () => {
  const { idDocumentEncrypted } = identityOf({ idDocumentType: 'AADHAAR', idNumber: '123456789012' })
  const bytes = Buffer.from(idDocumentEncrypted!, 'base64')
  bytes[bytes.length - 1] = (bytes.at(-1)! ^ 0xff) & 0xff

  expect(() => decryptIdNumber(bytes.toString('base64'))).toThrow()
})

it('stores nothing when only the last four are given, and never serves what it stores', () => {
  const columns = identityOf({ idDocumentType: 'AADHAAR', idDocumentLast4: '9012' })

  expect(columns).toMatchObject({ idDocumentHash: null, idDocumentEncrypted: null, idDocumentLast4: '9012' })
  expect(decryptIdNumber(null)).toBeNull()

  const served = withoutHash({ ...columns, name: 'Sunita Devi' })
  expect(served).toEqual({ idDocumentType: 'AADHAAR', idDocumentLast4: '9012', name: 'Sunita Devi', idDocumentOnFile: false })
})
