import { readChatUploadAcknowledgement } from './upload-contract'

const SCOPE_ID = '11111111-1111-4111-8111-111111111111'
const STORAGE_URL = 'https://project.supabase.co'
const FILE_NAME = `${SCOPE_ID}/image/123-proof.png`

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    url: `${STORAGE_URL}/storage/v1/object/sign/chat/${FILE_NAME}?token=fresh`,
    fileName: FILE_NAME,
    originalName: 'proof.png',
    fileType: 'image/png',
    fileSize: 5,
    category: 'image',
    ...overrides,
  }
}

const expected = {
  scopeId: SCOPE_ID,
  originalName: 'proof.png',
  fileType: 'image/png',
  fileSize: 5,
  storageBaseUrl: STORAGE_URL,
}

describe('chat upload acknowledgement', () => {
  it('accepts one exact signed object bound to the scope and selected file', () => {
    expect(readChatUploadAcknowledgement(acknowledgement(), expected)).toEqual(acknowledgement())
  })

  it.each([
    null,
    { ...acknowledgement(), extra: true },
    acknowledgement({
      url: `https://attacker.example/storage/v1/object/sign/chat/${FILE_NAME}?token=fresh`,
    }),
    acknowledgement({ url: `${STORAGE_URL}/storage/v1/object/public/chat/${FILE_NAME}` }),
    acknowledgement({ url: `${STORAGE_URL}/storage/v1/object/sign/chat/${FILE_NAME}` }),
    acknowledgement({ fileName: `22222222-2222-4222-8222-222222222222/image/proof.png` }),
    acknowledgement({ fileName: `${SCOPE_ID}/file/proof.png` }),
    acknowledgement({ originalName: 'other.png' }),
    acknowledgement({ fileType: 'text/html' }),
    acknowledgement({ fileSize: 6 }),
    acknowledgement({ category: 'html' }),
  ])('rejects malformed, cross-origin, or mismatched evidence %#', (value) => {
    expect(readChatUploadAcknowledgement(value, expected)).toBeNull()
  })
})
