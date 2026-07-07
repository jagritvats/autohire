-- LaTeX résumé import (§ Customize). The raw base .tex template the tailor rewrites;
-- the extracted plain text still lives in profile.master_resume for grounding.

alter table profile
  add column if not exists resume_latex text not null default '';
