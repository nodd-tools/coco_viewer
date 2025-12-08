#!/bin/bash

# Constants
BUCKET="nmfs_odp_hq"
DEST_PATH="nodd_tools/coco_viewer"
SOURCE_DIR="site"

# Upload everything in the source folder to the target bucket path
# -m: Multi-threaded (faster for many files)
# rsync: Synchronizes content (uploading only what changed)
# -r: Recursive (includes subfolders if you have an 'images' folder, etc.)
gsutil -m rsync -r "${SOURCE_DIR}" "gs://${BUCKET}/${DEST_PATH}"

echo "Upload complete."
