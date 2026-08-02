import { Form, redirect, useNavigation } from 'react-router'

import { auth } from '~/lib/auth/server'

import type { Route } from './+types/sign-in'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Sign in — CRM Leads' }]
}

export async function action({ request }: Route.ActionArgs): Promise<Response | { error: string }> {
  const form = await request.formData()
  // A FormData entry can be a File, and String(File) is "[object File]" — which
  // would be silently accepted as an email. Narrowing is the fix, not a cast.
  const email = readField(form, 'email')
  const password = readField(form, 'password')

  let response: Response
  try {
    response = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
  } catch {
    // Deliberately one message for both wrong-address and wrong-password. Two
    // messages is an account-enumeration oracle.
    return { error: 'That email and password do not match.' }
  }

  const cookie = response.headers.get('set-cookie')
  if (!cookie) {
    return { error: 'That email and password do not match.' }
  }

  return redirect('/earnings', { headers: { 'set-cookie': cookie } })
}

function readField(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

export default function SignIn({ actionData }: Route.ComponentProps): React.JSX.Element {
  const navigation = useNavigation()
  const busy = navigation.state === 'submitting'

  return (
    <main
      style={{ maxWidth: '24rem', margin: '0 auto', padding: 'var(--space-16) var(--space-6)' }}
    >
      <h1
        style={{
          fontSize: 'var(--type-2xl)',
          fontWeight: 'var(--font-weight-bold)',
          letterSpacing: '-0.015em',
        }}
      >
        Sign in
      </h1>

      <Form
        method="post"
        style={{ marginTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-4)' }}
      >
        <Field label="Email" name="email" type="email" autoComplete="username" />
        <Field label="Password" name="password" type="password" autoComplete="current-password" />

        {actionData && 'error' in actionData ? (
          <p
            role="alert"
            style={{
              margin: 0,
              padding: 'var(--space-3)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-danger-fill)',
              border: '1px solid var(--color-danger-stroke)',
              color: 'var(--color-danger-text)',
              fontSize: 'var(--type-sm)',
            }}
          >
            {actionData.error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          style={{
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            border: 'none',
            background: busy ? 'var(--color-action-disabled-bg)' : 'var(--color-action-primary-bg)',
            color: busy ? 'var(--color-action-disabled-fg)' : 'var(--color-action-primary-fg)',
            fontSize: 'var(--type-base)',
            fontWeight: 'var(--font-weight-semibold)',
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </Form>

      {/* There is no self-service reset, and saying so is the honest form.
          Transactional email is out of the MVP, so a "forgot password" link
          would open a screen that cannot do anything. */}
      <p
        style={{
          marginTop: 'var(--space-6)',
          fontSize: 'var(--type-xs)',
          color: 'var(--color-text-tertiary)',
        }}
      >
        Forgot your password? An admin can set a new one for you.
      </p>
    </main>
  )
}

function Field({
  label,
  name,
  type,
  autoComplete,
}: {
  label: string
  name: string
  type: string
  autoComplete: string
}): React.JSX.Element {
  return (
    <label style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <span style={{ fontSize: 'var(--type-sm)', fontWeight: 'var(--font-weight-medium)' }}>
        {label}
      </span>
      <input
        name={name}
        type={type}
        required
        autoComplete={autoComplete}
        style={{
          padding: 'var(--space-3)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-border-default)',
          background: 'var(--color-surface-1)',
          color: 'var(--color-text-primary)',
          fontSize: 'var(--type-base)',
        }}
      />
    </label>
  )
}
