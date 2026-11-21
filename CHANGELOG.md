# @dustinedwards/d1-dump

## 0.16.3

### Patch Changes

- A small object R2 refuses with error 10058, "Reduce your concurrent request rate for the same object", is written again after a pause (four tries, doubling from half a second). Overlapping runs write the same latest pointer and progress objects, and one refusal failed the whole backup (Carrel's CARREL-8).

## 0.16.2

### Patch Changes

- The files drill passes a files backup whose last complete pass found no files in its source, instead of failing it with "no copies".
