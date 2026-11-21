---
"@dustinedwards/d1-dump": patch
---

A small object R2 refuses with error 10058, "Reduce your concurrent request rate for the same object", is written again after a pause (four tries, doubling from half a second). Overlapping runs write the same latest pointer and progress objects, and one refusal failed the whole backup (Carrel's CARREL-8).
