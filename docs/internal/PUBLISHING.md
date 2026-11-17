# Publishing checklist (owner-only)

The working tree is scrubbed of personal data and `scripts/check-pii.mjs` guards it in CI.
**Git history is not.** Earlier commits contain the original author's résumé PDF
(`apps/web/uploads/…Resume_….pdf`), contact details in `apps/cli/src/index.ts`, the author's
résumé summary and personal project names in `packages/pipeline/src/seed.ts`, and the author's
commit email. A normal commit cannot remove them — anyone can check out an old commit.

These steps rewrite or replace history. They are destructive and must be run by the owner,
deliberately, **before** the repository (or any fork) is made public.

## Option 1 — fresh public history (recommended)

Simplest and certain. The private repo stays as the archive; the public repo starts at one
squashed commit.

```bash
# from a clean checkout of the scrubbed branch
git checkout --orphan public-main
git add -A
git -c user.name="<public name>" -c user.email="<id>+<user>@users.noreply.github.com" \
  commit -m "Initial public release"
git remote add public git@github.com:<owner>/<new-repo>.git
git push public public-main:main
```

## Option 2 — rewrite the existing history

Keeps history, but every clone, fork, PR ref and GitHub's cache still holds the old objects
until GitHub Support purges them. Making a repo private and public again does not purge them.

```bash
pip install git-filter-repo
git clone --mirror <repo-url> scrub && cd scrub
git filter-repo --invert-paths --path-glob 'apps/web/uploads/*'
# replacements.txt: one `literal==>replacement` per line (author email, name, project names…)
git filter-repo --replace-text ../replacements.txt
# optional: map the author identity to a GitHub noreply address
git filter-repo --mailmap ../mailmap
git push --force --mirror
```

Then ask GitHub Support to remove cached views and dangling objects.

## Before flipping the switch

- [ ] `node scripts/check-pii.mjs` passes
- [ ] `git log --all --format='%an <%ae>' | sort -u` shows only the identity you want public
- [ ] `git log --all --diff-filter=A --name-only | grep -iE 'upload|resume|\.pdf'` is empty
- [ ] LICENSE holder line and repository URLs in `package.json`, `.github/ISSUE_TEMPLATE/config.yml`,
      `SECURITY.md` and `CODE_OF_CONDUCT.md` point at the public repo
- [ ] Secrets: rotate any API keys that were ever in a local `.env` you shared
