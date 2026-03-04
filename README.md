# Okta → Airtable Live Sync

Automatically syncs Okta user changes to your Airtable base in real-time using Okta Event Hooks.

---

## What it does

| Okta Event | Action in Airtable |
|---|---|
| User created | New record added |
| User profile updated | Matching record updated |
| User activated / reactivated | Status updated |
| User deactivated | Status set to `INACTIVE` |
| User deleted | Status set to `INACTIVE` |

Matching uses **Okta User Id** first, falls back to **Primary email**.

---

## Setup: Step by Step

### Step 1 — Deploy the middleware to Vercel (free, ~3 minutes)

1. Go to [vercel.com](https://vercel.com) and sign up / log in (free tier is fine)
2. Install the Vercel CLI:
   ```
   npm install -g vercel
   ```
3. In your terminal, navigate to this folder and run:
   ```
   vercel deploy --prod
   ```
4. Follow the prompts. Vercel will give you a URL like:
   ```
   https://okta-airtable-sync-yourname.vercel.app
   ```
   **Copy this URL — you'll need it in Step 3.**

---

### Step 2 — Add environment variables in Vercel

In the Vercel dashboard → your project → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `OKTA_DOMAIN` | `yourorg.okta.com` |
| `OKTA_API_TOKEN` | Your Okta API token (see below) |
| `AIRTABLE_TOKEN` | Your Airtable personal access token (see below) |
| `AIRTABLE_BASE` | `appJXuJF1SCo1t7Jn` |
| `AIRTABLE_TABLE` | `Okta Users` (exact table name) |

After adding variables, redeploy: `vercel deploy --prod`

#### Getting your Okta API Token
1. Okta Admin Console → **Security → API → Tokens**
2. Click **Create Token** → name it (e.g. "Airtable Sync")
3. Copy the token — it's only shown once

#### Getting your Airtable Token
1. Go to [airtable.com/create/tokens](https://airtable.com/create/tokens)
2. Create a new token with scopes: `data.records:read`, `data.records:write`
3. Add your base (`appJXuJF1SCo1t7Jn`) under "Access"
4. Copy the token

---

### Step 3 — Create the Okta Event Hook

1. Okta Admin Console → **Workflow → Event Hooks**
2. Click **Create Event Hook**
3. Fill in:
   - **Name:** `Airtable User Sync`
   - **URL:** `https://your-vercel-url.vercel.app/okta-webhook`
4. Under **Subscribe to events**, add these event types:
   - `user.lifecycle.create`
   - `user.lifecycle.activate`
   - `user.lifecycle.deactivate`
   - `user.lifecycle.delete`
   - `user.lifecycle.reactivate`
   - `user.profile.update`
5. Click **Save**

---

### Step 4 — Verify the hook

1. On the Event Hooks page, find your new hook
2. Click **Actions → Verify** — Okta will send a verification request to your endpoint
3. It should show **Verified** within a few seconds

**That's it.** From this point on, any user change in Okta will automatically update your Airtable within seconds.

---

## Testing

To test manually, you can deactivate and reactivate a test user in Okta and watch the Airtable record update in real-time.

You can also view logs in the Vercel dashboard → your project → **Deployments → Functions**.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Hook shows "Failed" in Okta | Check Vercel function logs for errors |
| User not found in Airtable | Confirm table name matches `AIRTABLE_TABLE` exactly |
| 401 errors | Regenerate and re-enter your API tokens |
| Vercel cold start timeout | Okta retries failed hooks automatically — this resolves itself |
