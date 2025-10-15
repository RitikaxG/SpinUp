export interface ClerkUser{
    id : string,
    first_name : string | null;
    last_name : string | null,
    email_addresses : { email_address : string }[],
    image_url? : string,
    external_accounts? : {
        provider : string,
        provider_user_id : string
    }[]
}