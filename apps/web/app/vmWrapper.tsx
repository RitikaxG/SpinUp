interface VMWrapperProps {
    vmIP : string
}
export const VMWrapper : React.FC<VMWrapperProps> = ({ vmIP }) => {
    return <div className="w-[100%] h-[100%]">
        <iframe src={`http://${vmIP}:8080`} className="w-[100%] h-[100%]"></iframe>
    </div>
}