# Kali MCP for LittleJohn

This image wraps the community `k3nn3dy-ai/kali-mcp` SSE MCP server in an
IronNest-owned build context. The upstream source is pinned by commit in the
Dockerfile.

Runtime conventions:

- MCP endpoint: `http://kali-mcp-littlejohn:8000/sse`
- Persistent private workspace: `/work`
- Shared report handoff: `/reports`
- Session state: `/work/sessions`
- Default assessment scope: lab-only unless an explicit assessment record says
  otherwise.

Installed tool baseline:

- Reconnaissance: Nmap, Masscan, Amass, theHarvester, ffuf
- Web application testing: OWASP ZAP, sqlmap, Nikto, XSStrike
- Exploitation: Metasploit Framework, Hydra, John the Ripper
- Vulnerability scanning: Nuclei, GVM/OpenVAS packages, Lynis
- Malware and forensics: YARA, Volatility 3, Autopsy

GVM/OpenVAS is installed as Kali packages, but its scanner database and service
state still need runtime initialization before full scanner use. Treat that as a
separate approved assessment-prep step because it is heavy and stateful.

The container is intentionally not published to the Windows host. LittleJohn
reaches it through `littlejohn-kali-net`; package egress uses the Kali-only
`littlejohn-kali-egress-net` bridge when the container is running.
