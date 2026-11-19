# Markenza Firestore Security Specification

## 1. Data Invariants
1. Public visitors can ONLY read `projects` where `published == true` and the single `settings/landing` document.
2. Public visitors can NEVER list, read, update, or delete `enquiries` (PII protection for emails and WhatsApp numbers).
3. Public visitors creating an enquiry MUST supply all required fields within strict string length bounds, set initial `status` to `'New'` and `internalNotes` to `''`, and use server timestamp (`request.time`) for `createdAt` and `updatedAt`.
4. Only verified admins (`request.auth.token.email_verified == true` AND either bootstrapped studio owner email `vijaypriyanshpersonal@gmail.com` or an existing `/admins/{uid}` document) can manage `projects`, read/update/delete `enquiries`, or update `settings/landing`.
5. Document IDs must match `^[a-zA-Z0-9_-]+$` and be <= 128 characters.
6. Immutable fields (`createdAt` on `projects` and `enquiries`) cannot be altered after creation.

## 2. Adversarial Test Vectors ("Dirty Dozen")
1. Unauthenticated `get` on `/enquiries/{id}` -> PERMISSION_DENIED
2. Unauthenticated `list` on `/enquiries` -> PERMISSION_DENIED
3. Unauthenticated `list` on `/projects` without `where('published', '==', true)` -> PERMISSION_DENIED
4. Unauthenticated `get` on unpublished `/projects/{draftId}` -> PERMISSION_DENIED
5. Public enquiry `create` with spoofed `status: "Closed"` -> PERMISSION_DENIED
6. Public enquiry `create` with shadow ghost field `isVerified: true` -> PERMISSION_DENIED
7. Public enquiry `create` with client-forged `createdAt` != `request.time` -> PERMISSION_DENIED
8. Public enquiry `create` with 1MB string in `name` -> PERMISSION_DENIED
9. Non-admin authenticated user attempting `create` on `/admins/{uid}` (self-escalation) -> PERMISSION_DENIED
10. Unverified admin email (`email_verified == false`) attempting to read `/enquiries` -> PERMISSION_DENIED
11. Non-admin authenticated user attempting to `update` `/settings/landing` -> PERMISSION_DENIED
12. Admin `update` on `/enquiries/{id}` attempting to mutate immutable `createdAt` or `email` -> PERMISSION_DENIED
