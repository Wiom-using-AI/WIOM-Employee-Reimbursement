import re
import zipfile
import os
import shutil
from typing import Dict, Tuple


SUPPORTED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".webp"}

# Characters invalid in Windows filenames
_INVALID_CHARS = re.compile(r'[<>:"|?*\x00-\x1f]')


def _safe_part(name: str) -> str:
    """Sanitize a single path component for safe use on Windows."""
    name = _INVALID_CHARS.sub("_", name)
    name = name.strip(". ")   # Windows strips trailing dots/spaces from dir names
    return name or "_"


def extract_zip(zip_path: str, extract_to: str) -> Tuple[Dict[str, Dict[str, str]], Dict[str, str]]:
    """
    Extract ZIP preserving folder structure.

    Returns:
        by_folder : Dict[folder_name, Dict[filename, full_filepath]]
                    folder_name is the immediate parent dir inside the ZIP
                    (typically the employee ID or employee name).
                    Root-level files land under the key "" (empty string).

        all_files : Dict[display_key, full_filepath]
                    display_key = "FOLDER/filename" for nested files,
                                  "filename" for root-level files.
                    Used as the unified key for OCR map + row.matched_file.
    """
    if os.path.exists(extract_to):
        shutil.rmtree(extract_to)
    os.makedirs(extract_to, exist_ok=True)

    by_folder: Dict[str, Dict[str, str]] = {}
    all_files: Dict[str, str] = {}

    with zipfile.ZipFile(zip_path, "r") as zf:
        for member in zf.infolist():
            if member.is_dir():
                continue

            # Normalise separators: ZIP spec uses "/" but Windows tools emit "\"
            parts = [p for p in member.filename.replace("\\", "/").split("/") if p]
            if not parts:
                continue

            # Sanitize every path component so trailing spaces/dots don't
            # cause Windows to silently rename the directory and break paths.
            parts = [_safe_part(p) for p in parts]

            filename = parts[-1]
            _, ext = os.path.splitext(filename.lower())
            if ext not in SUPPORTED_EXTENSIONS:
                continue

            # Immediate parent folder (first level only, ignore deeper nesting)
            folder_name = parts[-2] if len(parts) >= 2 else ""

            # Build destination path: extract_to/folder_name/filename
            dest_dir = os.path.join(extract_to, folder_name) if folder_name else extract_to
            os.makedirs(dest_dir, exist_ok=True)

            # Handle filename collisions within the same folder
            dest_name = filename
            dest_path = os.path.join(dest_dir, dest_name)
            counter = 1
            while os.path.exists(dest_path):
                base, extension = os.path.splitext(filename)
                dest_name = f"{base}_{counter}{extension}"
                dest_path = os.path.join(dest_dir, dest_name)
                counter += 1

            with zf.open(member) as src, open(dest_path, "wb") as dst:
                dst.write(src.read())

            # Build display key
            display_key = f"{folder_name}/{dest_name}" if folder_name else dest_name

            by_folder.setdefault(folder_name, {})[dest_name] = dest_path
            all_files[display_key] = dest_path

    return by_folder, all_files


def list_zip_structure(zip_path: str) -> Dict[str, list]:
    """Preview folder → [files] structure of a ZIP without extracting."""
    structure: Dict[str, list] = {}
    with zipfile.ZipFile(zip_path, "r") as zf:
        for member in zf.infolist():
            if member.is_dir():
                continue
            parts = [_safe_part(p) for p in member.filename.replace("\\", "/").split("/") if p]
            if not parts:
                continue
            filename = parts[-1]
            _, ext = os.path.splitext(filename.lower())
            if ext not in SUPPORTED_EXTENSIONS:
                continue
            folder = parts[-2] if len(parts) >= 2 else ""
            structure.setdefault(folder, []).append(filename)
    return structure
