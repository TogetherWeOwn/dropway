/** Stable delivery errors. Other core families may extend this catalog. */
export const ERROR_CODES = {
  invalid_transfer: { status: 400, retryable: false, hint: "Correct the delivery fields and retry." },
  invalid_transfer_password: { status: 400, retryable: false, hint: "Use 8-1,024 characters without NUL, or empty for no password." },
  invalid_transfer_expiry: { status: 400, retryable: false, hint: "Choose a deadline from one hour to the effective expiry ceiling." },
  transfer_not_found: { status: 404, retryable: false, hint: "Check the reference and use its sender's key." },
  transfer_conflict: { status: 409, retryable: false, hint: "Read the transfer again; closed or notified deliveries cannot be edited." },
  transfer_origin_required: { status: 409, retryable: false, hint: "Configure a separate sites origin." },
  transfer_immutable: { status: 409, retryable: false, hint: "Use transfer operations, or create a new delivery for changed files." },
  transfer_password_proof_required: { status: 403, retryable: false, hint: "Send currentPassword together with the new password." },
  transfer_locked: { status: 403, retryable: false, hint: "Unlock the delivery on its app-origin page." },
  transfer_download_required: { status: 403, retryable: false, hint: "Use the transfer page's sites-host download links." },
  transfer_unavailable: { status: 451, retryable: false, hint: "Contact the sender." },
  transfer_gone: { status: 410, retryable: false, hint: "Ask the sender for a new delivery." },
  transfer_unlock_unavailable: { status: 503, retryable: true, hint: "Retry later." },
  invalid_transfer_range: { status: 416, retryable: false, hint: "Request one satisfiable byte range." },
  export_too_many_files: { status: 413, retryable: false, hint: "Download file by file with list_files and read_file." },
  export_too_large: { status: 413, retryable: false, hint: "Download file by file with list_files and read_file." },
} as const;
